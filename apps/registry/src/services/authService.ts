// Copyright The Harmoniq Authors
// SPDX-License-Identifier: Apache-2.0

import { createHash, randomBytes, randomUUID } from 'crypto';
import { Invitation, Prisma, PrismaClient, User } from '@prisma/client';
import { ILogger } from '@harmoniq/core/dist/ports/ILogger';
import { IdentityError, IdentityUserInfo } from '@harmoniq/core/dist/ports/IdentityProvider';
import { SessionResponse, SessionUser } from '@harmoniq/core/dist/schemas/AuthSchemas';
import { ACCESS_TOKEN_TTL_SECONDS, signAccessToken } from '../auth/tokens';
import { parseSsoProviderId } from './ssoIds';
import { grantInvitation } from './invitations';

const REFRESH_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;
/** SSO-27: how often a session re-checks the IdP session with its refresh token. */
const SSO_RECHECK_MS = 60 * 60 * 1000;

/** Asks the IdP whether a session is still valid; returns its new refresh token or null. */
export type SsoSessionCheck = (provider: string, refreshToken: string) => Promise<string | null>;
// Two tabs refreshing at once both present the same token; the loser is not an attack.
const CONCURRENT_REFRESH_GRACE_MS = 10_000;

const hashToken = (raw: string) => createHash('sha256').update(raw).digest('hex');

/**
 * PPL-02: the workspaces whose invitations a sign-in may accept. Instance-wide methods
 * (email, GitHub, instance OIDC) prove the email for every workspace. A workspace's own SSO
 * reaches that workspace; an organization's SSO, the organization's workspaces that use it
 * (those without their own SSO, ORG-05).
 */
function reachableWorkspaces(provider: string): Prisma.WorkspaceWhereInput {
  const sso = parseSsoProviderId(provider);
  if (!sso) return {};
  if (sso.subject.kind === 'workspace') return { slug: sso.subject.slug };
  return {
    organization: { slug: sso.subject.slug },
    OR: [
      { WorkspaceConfig: { is: null } },
      {
        WorkspaceConfig: {
          oidcConfig: { equals: Prisma.DbNull },
          samlConfig: { equals: Prisma.DbNull },
        },
      },
    ],
  };
}

/** PPL-02: whether a sign-in through `provider` may accept this invitation. */
export async function invitationReachable(
  tx: Prisma.TransactionClient,
  provider: string,
  invitation: Invitation
) {
  const sso = parseSsoProviderId(provider);
  if (!sso) return true; // instance-wide methods prove the email everywhere
  if (invitation.workspaceId) {
    const count = await tx.workspace.count({
      where: { id: invitation.workspaceId, ...reachableWorkspaces(provider) },
    });
    return count > 0;
  }
  if (sso.subject.kind !== 'organization') return false;
  const org = await tx.organization.findUnique({
    where: { id: invitation.organizationId! },
    select: { slug: true },
  });
  return org?.slug === sso.subject.slug;
}

/**
 * Turns a proven identity into a Harmoniq session. Runs on the system role: sign-in
 * happens before any tenant is known.
 */
export class AuthService {
  constructor(
    private db: PrismaClient,
    private jwtSecret: string,
    private logger: ILogger,
    private sso?: {
      seal: (plain: string) => string;
      open: (sealed: string) => string;
      check: SsoSessionCheck;
    },
    /**
     * Whether sessions from this sign-in method may continue. A session from a method
     * turned off since sign-in (HARMONIQ_AUTH_METHODS or the admin panel) is ended.
     */
    private providerEnabled: (provider: string) => boolean = () => true
  ) {}

  /**
   * Links the identity to a user and issues a session. Accounts are created or linked by
   * email only when the provider verified the email; otherwise anyone could pre-register
   * an unverified address and take over the account when its owner signs in.
   */
  async completeLogin(info: IdentityUserInfo, provider: string): Promise<SessionResponse> {
    const session = await this.login(info, provider);
    return session.response;
  }

  /** Like `completeLogin`, also returning the user (for SSO provisioning). */
  async login(
    info: IdentityUserInfo,
    provider: string
  ): Promise<{ user: User; response: SessionResponse }> {
    if (!info.emailVerified) {
      throw new IdentityError('email_not_verified', 'Sign-in requires a verified email address');
    }
    const email = info.email.trim().toLowerCase();

    const link = () =>
      this.db.$transaction(async (tx) => {
        const now = new Date();
        const identity = await tx.identity.findUnique({
          where: { provider_providerUserId: { provider, providerUserId: info.providerUserId } },
        });

        let user: User;
        if (identity) {
          user = await tx.user.findUniqueOrThrow({ where: { id: identity.userId } });
          await tx.identity.update({
            where: { id: identity.id },
            data: { lastUsedAt: now, email },
          });
        } else {
          user =
            (await tx.user.findFirst({
              where: { email: { equals: email, mode: 'insensitive' } },
            })) ??
            (await tx.user.create({
              data: { email, name: info.name ?? null, avatarUrl: info.avatarUrl ?? null },
            }));
          await tx.identity.create({
            data: {
              userId: user.id,
              provider,
              providerUserId: info.providerUserId,
              email,
              lastUsedAt: now,
            },
          });
        }

        // Pending invitations are addressed to this (now verified) email: accept them, but
        // only those this session can reach (PPL-02). A workspace's or organization's own
        // IdP vouches for emails only within that workspace or organization.
        const invitations = await tx.invitation.findMany({
          where: { email, acceptedAt: null, revokedAt: null, expiresAt: { gt: now } },
        });
        for (const invitation of invitations) {
          if (await invitationReachable(tx, provider, invitation)) {
            await grantInvitation(tx, invitation, user.id);
          }
        }

        return tx.user.update({
          where: { id: user.id },
          data: {
            lastLoginAt: now,
            name: user.name ?? info.name ?? null,
            avatarUrl: user.avatarUrl ?? info.avatarUrl ?? null,
          },
        });
      });

    let user: User;
    try {
      user = await link();
    } catch (err) {
      // Two simultaneous first logins race on the unique identity/email; the retry links.
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        user = await link();
      } else {
        throw err;
      }
    }

    this.logger.info(`auth.login user=${user.id} provider=${provider}`);
    const ssoRefreshToken =
      info.refreshToken && this.sso ? this.sso.seal(info.refreshToken) : undefined;
    return {
      user,
      response: await this.issue(user, randomUUID(), {
        provider,
        ssoRefreshToken,
        ssoCheckedAt: ssoRefreshToken ? new Date() : undefined,
      }),
    };
  }

  /**
   * Rotates a refresh token. Presenting an already-rotated token (outside a short grace
   * window for concurrent tabs) means it was stolen: the whole family is revoked.
   */
  async refresh(rawToken: string): Promise<SessionResponse | null> {
    const now = Date.now();
    const record = await this.db.refreshToken.findUnique({
      where: { tokenHash: hashToken(rawToken) },
    });
    if (!record || record.revokedAt || record.expiresAt.getTime() <= now) return null;
    if (record.provider && !this.providerEnabled(record.provider)) {
      await this.revokeFamily(record.familyId);
      this.logger.info(
        `auth.session_ended user=${record.userId} reason=method_disabled provider=${record.provider}`
      );
      return null;
    }

    // POL-07: the strictest session policy of the user's organizations.
    const ended = await this.sessionPolicyEnds(record, now);
    if (ended) {
      await this.revokeFamily(record.familyId);
      this.logger.info(`auth.session_ended user=${record.userId} reason=${ended}`);
      return null;
    }

    const claimed = await this.db.refreshToken.updateMany({
      where: { id: record.id, usedAt: null },
      data: { usedAt: new Date(now) },
    });
    if (claimed.count === 0) {
      const current = await this.db.refreshToken.findUnique({ where: { id: record.id } });
      const usedAt = current?.usedAt?.getTime() ?? 0;
      if (now - usedAt > CONCURRENT_REFRESH_GRACE_MS) {
        await this.revokeFamily(record.familyId);
        this.logger.warn(`auth.refresh_reuse user=${record.userId} family revoked`);
      }
      return null;
    }

    const user = await this.db.user.findUnique({ where: { id: record.userId } });
    if (!user) return null;

    // SSO-08/27: an SSO session lives only as long as the IdP agrees.
    let ssoRefreshToken = record.ssoRefreshToken ?? undefined;
    let ssoCheckedAt = record.ssoCheckedAt ?? undefined;
    if (
      ssoRefreshToken &&
      record.provider &&
      this.sso &&
      (!ssoCheckedAt || now - ssoCheckedAt.getTime() > SSO_RECHECK_MS)
    ) {
      const renewed = await this.sso
        .check(record.provider, this.sso.open(ssoRefreshToken))
        .catch(() => null);
      if (!renewed) {
        await this.revokeFamily(record.familyId);
        this.logger.info(`auth.sso_session_ended user=${record.userId}`);
        return null;
      }
      ssoRefreshToken = this.sso.seal(renewed);
      ssoCheckedAt = new Date(now);
    }
    return this.issue(user, record.familyId, {
      provider: record.provider ?? undefined,
      ssoRefreshToken,
      ssoCheckedAt,
    });
  }

  /**
   * POL-07: why the organization policy ends this session (null: it may continue). The
   * session started with the family's first token; it was last active when this token was
   * issued (access tokens last minutes, so an active session refreshes often).
   */
  private async sessionPolicyEnds(
    record: { userId: string; familyId: string; createdAt: Date },
    now: number
  ): Promise<'session_max' | 'idle_timeout' | null> {
    const policies = await this.db.orgPolicy.findMany({
      where: {
        OR: [{ sessionMaxHours: { not: null } }, { idleTimeoutMinutes: { not: null } }],
        organization: {
          deletedAt: null,
          OR: [
            { Members: { some: { userId: record.userId } } },
            {
              Workspaces: {
                some: { WorkspaceMembers: { some: { userId: record.userId } } },
              },
            },
          ],
        },
      },
      select: { sessionMaxHours: true, idleTimeoutMinutes: true },
    });
    if (!policies.length) return null;
    const strictest = (values: (number | null)[]) => {
      const set = values.filter((v): v is number => v !== null);
      return set.length ? Math.min(...set) : null;
    };
    const idle = strictest(policies.map((p) => p.idleTimeoutMinutes));
    if (idle !== null && now - record.createdAt.getTime() > idle * 60_000) return 'idle_timeout';
    const maxHours = strictest(policies.map((p) => p.sessionMaxHours));
    if (maxHours !== null) {
      const first = await this.db.refreshToken.findFirst({
        where: { familyId: record.familyId },
        orderBy: { createdAt: 'asc' },
        select: { createdAt: true },
      });
      const started = (first ?? record).createdAt.getTime();
      if (now - started > maxHours * 3_600_000) return 'session_max';
    }
    return null;
  }

  async logout(rawToken: string): Promise<void> {
    const record = await this.db.refreshToken.findUnique({
      where: { tokenHash: hashToken(rawToken) },
    });
    if (record) await this.revokeFamily(record.familyId);
  }

  async sessionUser(userId: string): Promise<SessionUser | null> {
    const user = await this.db.user.findUnique({
      where: { id: userId },
      include: { InstanceAdmin: true },
    });
    if (!user) return null;
    return {
      id: user.id,
      email: user.email,
      name: user.name,
      avatarUrl: user.avatarUrl,
      isInstanceAdmin: !!user.InstanceAdmin && !user.InstanceAdmin.revokedAt,
    };
  }

  private async revokeFamily(familyId: string) {
    await this.db.refreshToken.updateMany({
      where: { familyId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }

  private async issue(
    user: User,
    familyId: string,
    session: { provider?: string; ssoRefreshToken?: string; ssoCheckedAt?: Date } = {}
  ): Promise<SessionResponse> {
    const now = Date.now();
    const refreshToken = randomBytes(32).toString('base64url');
    const refreshTokenExpiresAt = new Date(now + REFRESH_TOKEN_TTL_MS);
    await this.db.refreshToken.create({
      data: {
        userId: user.id,
        tokenHash: hashToken(refreshToken),
        familyId,
        expiresAt: refreshTokenExpiresAt,
        provider: session.provider,
        ssoRefreshToken: session.ssoRefreshToken,
        ssoCheckedAt: session.ssoCheckedAt,
      },
    });

    const sessionUser = await this.sessionUser(user.id);
    return {
      accessToken: await signAccessToken(
        { userId: user.id, email: user.email, provider: session.provider },
        this.jwtSecret
      ),
      accessTokenExpiresAt: new Date(now + ACCESS_TOKEN_TTL_SECONDS * 1000).toISOString(),
      refreshToken,
      refreshTokenExpiresAt: refreshTokenExpiresAt.toISOString(),
      user: sessionUser!,
    };
  }
}
