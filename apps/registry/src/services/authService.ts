// Copyright The Harmoniq Authors
// SPDX-License-Identifier: Apache-2.0

import { createHash, randomBytes, randomUUID } from 'crypto';
import { Invitation, Prisma, PrismaClient, User } from '@prisma/client';
import { ILogger } from '@harmoniq/core/dist/ports/ILogger';
import { IdentityError, IdentityUserInfo } from '@harmoniq/core/dist/ports/IdentityProvider';
import {
  MfaChallengeResponse,
  SessionResponse,
  SessionSummary,
  SessionUser,
  SignInResponse,
} from '@harmoniq/core/dist/schemas/AuthSchemas';
import {
  ACCESS_TOKEN_TTL_SECONDS,
  MFA_CHALLENGE_SECONDS,
  signAccessToken,
  signMfaChallenge,
  verifyMfaChallenge,
} from '../auth/tokens';
import { useRecoveryCode, verifyTotp } from './totp';
import { parseSsoProviderId } from './ssoIds';
import { grantInvitation } from './invitations';

/** SES-01 defaults when no instance setting says otherwise. */
const DEFAULT_SESSION = { maxDays: 30, idleMinutes: null as number | null };

/** Where a request came from, for the session list (SES-02). */
export interface ClientInfo {
  ip?: string;
  userAgent?: string;
}

/** SES-03: sign-ins through a workspace's or organization's SSO skip the second factor. */
export const isTenantSso = (provider: string | null | undefined) => !!parseSsoProviderId(provider);
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
    private providerEnabled: (provider: string) => boolean = () => true,
    private options: {
      /** SES-01: the instance's session lifetime and idle timeout. */
      session?: () => { maxDays: number; idleMinutes: number | null };
      /** SES-03: opens a user's sealed TOTP secret. */
      openSecret?: (sealed: string) => string;
    } = {}
  ) {}

  /**
   * Links the identity to a user and issues a session. Accounts are created or linked by
   * email only when the provider verified the email; otherwise anyone could pre-register
   * an unverified address and take over the account when its owner signs in.
   */
  async completeLogin(
    info: IdentityUserInfo,
    provider: string,
    client: ClientInfo = {}
  ): Promise<SignInResponse> {
    const session = await this.login(info, provider, client);
    return session.response;
  }

  /**
   * Like `completeLogin`, also returning the user (for SSO provisioning). A user with MFA
   * signing in without tenant SSO gets a challenge instead of a session (SES-03).
   */
  async login(
    info: IdentityUserInfo,
    provider: string,
    client: ClientInfo = {}
  ): Promise<{ user: User; response: SignInResponse }> {
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

    // SES-04: a suspended account proves its identity but gets no session.
    if (user.suspendedAt) {
      this.logger.info(`auth.login_refused user=${user.id} reason=suspended`);
      throw new IdentityError('account_suspended', 'This account is suspended');
    }
    this.logger.info(`auth.login user=${user.id} provider=${provider}`);
    const ssoRefreshToken =
      info.refreshToken && this.sso ? this.sso.seal(info.refreshToken) : undefined;
    if (user.mfaEnabledAt && !isTenantSso(provider)) {
      return { user, response: await this.challenge(user, provider, ssoRefreshToken) };
    }
    return {
      user,
      response: await this.issue(user, randomUUID(), {
        provider,
        ssoRefreshToken,
        ssoCheckedAt: ssoRefreshToken ? new Date() : undefined,
        client,
      }),
    };
  }

  private async challenge(
    user: User,
    provider: string,
    ssoRefreshToken?: string
  ): Promise<MfaChallengeResponse> {
    return {
      mfaRequired: true,
      challenge: await signMfaChallenge(
        { userId: user.id, provider, ssoRefreshToken },
        this.jwtSecret
      ),
      expiresAt: new Date(Date.now() + MFA_CHALLENGE_SECONDS * 1000).toISOString(),
    };
  }

  /**
   * SES-03: checks a TOTP or recovery code for the user. A TOTP code is accepted once (its
   * time step is recorded); a recovery code is used up. False when it doesn't match.
   */
  async checkSecondFactor(user: User, code: string): Promise<boolean> {
    if (!user.mfaSecretSealed || !this.options.openSecret) return false;
    const trimmed = code.trim();
    if (/^\d{6}$/.test(trimmed)) {
      const step = verifyTotp(this.options.openSecret(user.mfaSecretSealed), trimmed, {
        lastStep: user.mfaLastStep,
      });
      if (step === null) return false;
      // Only one request can move the step forward: a concurrent replay loses.
      const { count } = await this.db.user.updateMany({
        where: {
          id: user.id,
          OR: [{ mfaLastStep: null }, { mfaLastStep: { lt: step } }],
        },
        data: { mfaLastStep: step },
      });
      return count === 1;
    }
    const remaining = useRecoveryCode(user.mfaRecoveryCodes, trimmed);
    if (!remaining) return false;
    const { count } = await this.db.user.updateMany({
      where: { id: user.id, mfaRecoveryCodes: { equals: user.mfaRecoveryCodes } },
      data: { mfaRecoveryCodes: remaining },
    });
    if (count === 1)
      this.logger.info(`auth.mfa_recovery_code_used user=${user.id} left=${remaining.length}`);
    return count === 1;
  }

  /** SES-03: the second step of a sign-in: the challenge and a code give the session. */
  async verifyMfa(challenge: string, code: string, client: ClientInfo = {}) {
    let claims: Awaited<ReturnType<typeof verifyMfaChallenge>>;
    try {
      claims = await verifyMfaChallenge(challenge, this.jwtSecret);
    } catch {
      throw new IdentityError('mfa_expired', 'The sign-in took too long; start again');
    }
    const user = await this.db.user.findUnique({ where: { id: claims.userId } });
    if (!user || user.suspendedAt || !user.mfaEnabledAt) {
      throw new IdentityError('mfa_expired', 'The sign-in took too long; start again');
    }
    if (!(await this.checkSecondFactor(user, code))) {
      this.logger.warn(`auth.mfa_failed user=${user.id}`);
      throw new IdentityError('mfa_invalid', 'That code is not valid');
    }
    return this.issue(user, randomUUID(), {
      provider: claims.provider,
      ssoRefreshToken: claims.ssoRefreshToken,
      ssoCheckedAt: claims.ssoRefreshToken ? new Date() : undefined,
      mfaVerified: true,
      client,
    });
  }

  /**
   * SES-03: marks the session of `rawToken` (the user's own) as having passed a second
   * factor, after enrolment, and returns new tokens for it.
   */
  async upgradeSession(userId: string, rawToken: string, client: ClientInfo = {}) {
    const record = await this.db.refreshToken.findUnique({
      where: { tokenHash: hashToken(rawToken) },
    });
    if (!record || record.userId !== userId || record.revokedAt || record.usedAt) return null;
    const user = await this.db.user.findUniqueOrThrow({ where: { id: userId } });
    await this.db.refreshToken.update({ where: { id: record.id }, data: { usedAt: new Date() } });
    return this.issue(user, record.familyId, {
      provider: record.provider ?? undefined,
      ssoRefreshToken: record.ssoRefreshToken ?? undefined,
      ssoCheckedAt: record.ssoCheckedAt ?? undefined,
      mfaVerified: true,
      client,
    });
  }

  /**
   * Rotates a refresh token. Presenting an already-rotated token (outside a short grace
   * window for concurrent tabs) means it was stolen: the whole family is revoked.
   */
  async refresh(rawToken: string, client: ClientInfo = {}): Promise<SessionResponse | null> {
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

    // SES-01, POL-07: the instance's limits, shortened by the user's organizations.
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
    if (user.suspendedAt) {
      await this.revokeFamily(record.familyId);
      return null;
    }

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
      mfaVerified: record.mfaVerified,
      client: {
        ip: client.ip ?? record.ip ?? undefined,
        userAgent: client.userAgent ?? record.userAgent ?? undefined,
      },
    });
  }

  /**
   * SES-01, POL-07: a user's session limits: the instance's, shortened by the strictest
   * policy among the user's organizations (memberships in their workspaces count).
   */
  async sessionLimits(userId: string): Promise<{ maxHours: number; idleMinutes: number | null }> {
    const instance = this.options.session?.() ?? DEFAULT_SESSION;
    const policies = await this.db.orgPolicy.findMany({
      where: {
        OR: [{ sessionMaxHours: { not: null } }, { idleTimeoutMinutes: { not: null } }],
        organization: {
          deletedAt: null,
          OR: [
            { Members: { some: { userId } } },
            { Workspaces: { some: { WorkspaceMembers: { some: { userId } } } } },
          ],
        },
      },
      select: { sessionMaxHours: true, idleTimeoutMinutes: true },
    });
    const min = (values: (number | null)[]) => {
      const set = values.filter((v): v is number => v !== null);
      return set.length ? Math.min(...set) : null;
    };
    return {
      maxHours: min([instance.maxDays * 24, ...policies.map((p) => p.sessionMaxHours)])!,
      idleMinutes: min([instance.idleMinutes, ...policies.map((p) => p.idleTimeoutMinutes)]),
    };
  }

  /** When the session that began at `started` must end, at the latest (SES-01). */
  private async familyStart(familyId: string) {
    const first = await this.db.refreshToken.findFirst({
      where: { familyId },
      orderBy: { createdAt: 'asc' },
      select: { createdAt: true },
    });
    return first?.createdAt ?? new Date();
  }

  /**
   * Why the limits end this session (null: it may continue). The session started with the
   * family's first token; it was last active when this token was issued (access tokens
   * last minutes, so an active session refreshes often).
   */
  private async sessionPolicyEnds(
    record: { userId: string; familyId: string; createdAt: Date },
    now: number
  ): Promise<'session_max' | 'idle_timeout' | null> {
    const limits = await this.sessionLimits(record.userId);
    if (
      limits.idleMinutes !== null &&
      now - record.createdAt.getTime() > limits.idleMinutes * 60_000
    ) {
      return 'idle_timeout';
    }
    const started = (await this.familyStart(record.familyId)).getTime();
    if (now - started > limits.maxHours * 3_600_000) return 'session_max';
    return null;
  }

  // ─── Sessions (SES-02) ────────────────────────────────────────────────────

  /** The user's live sessions (refresh-token families), most recently used first. */
  async listSessions(userId: string, currentId?: string): Promise<SessionSummary[]> {
    const now = new Date();
    const tokens = await this.db.refreshToken.findMany({
      where: { userId, revokedAt: null },
      orderBy: { createdAt: 'asc' },
      select: {
        familyId: true,
        createdAt: true,
        expiresAt: true,
        usedAt: true,
        provider: true,
        ip: true,
        userAgent: true,
        mfaVerified: true,
      },
    });
    const families = new Map<string, { first: Date; latest: (typeof tokens)[number] }>();
    for (const t of tokens) {
      const f = families.get(t.familyId);
      if (!f) families.set(t.familyId, { first: t.createdAt, latest: t });
      else f.latest = t;
    }
    return [...families]
      .filter(([, f]) => !f.latest.usedAt && f.latest.expiresAt > now)
      .map(([id, f]) => ({
        id,
        provider: f.latest.provider,
        createdAt: f.first.toISOString(),
        lastActiveAt: f.latest.createdAt.toISOString(),
        expiresAt: f.latest.expiresAt.toISOString(),
        ip: f.latest.ip,
        userAgent: f.latest.userAgent,
        mfa: f.latest.mfaVerified,
        current: id === currentId,
      }))
      .sort((a, b) => b.lastActiveAt.localeCompare(a.lastActiveAt));
  }

  /** Ends one of the user's sessions; false when it isn't theirs (or already ended). */
  async endSession(userId: string, familyId: string) {
    const { count } = await this.db.refreshToken.updateMany({
      where: { userId, familyId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    return count > 0;
  }

  /** Ends every session of the user, but `keep` (e.g. the current one); returns how many. */
  async endSessions(userId: string, keep?: string) {
    const families = await this.db.refreshToken.findMany({
      where: { userId, revokedAt: null, ...(keep && { familyId: { not: keep } }) },
      distinct: ['familyId'],
      select: { familyId: true },
    });
    await this.db.refreshToken.updateMany({
      where: { userId, revokedAt: null, ...(keep && { familyId: { not: keep } }) },
      data: { revokedAt: new Date() },
    });
    return families.length;
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
    session: {
      provider?: string;
      ssoRefreshToken?: string;
      ssoCheckedAt?: Date;
      mfaVerified?: boolean;
      client?: ClientInfo;
    } = {}
  ): Promise<SessionResponse> {
    const now = Date.now();
    const refreshToken = randomBytes(32).toString('base64url');
    // SES-01: no later than the session's maximum, nor its idle timeout from now.
    const limits = await this.sessionLimits(user.id);
    const started = (await this.familyStart(familyId)).getTime();
    const refreshTokenExpiresAt = new Date(
      Math.min(
        started + limits.maxHours * 3_600_000,
        limits.idleMinutes === null ? Infinity : now + limits.idleMinutes * 60_000
      )
    );
    await this.db.refreshToken.create({
      data: {
        userId: user.id,
        tokenHash: hashToken(refreshToken),
        familyId,
        expiresAt: refreshTokenExpiresAt,
        provider: session.provider,
        ssoRefreshToken: session.ssoRefreshToken,
        ssoCheckedAt: session.ssoCheckedAt,
        mfaVerified: !!session.mfaVerified,
        ip: session.client?.ip?.slice(0, 64),
        userAgent: session.client?.userAgent?.slice(0, 300),
      },
    });

    const sessionUser = await this.sessionUser(user.id);
    return {
      accessToken: await signAccessToken(
        {
          userId: user.id,
          email: user.email,
          provider: session.provider,
          sessionId: familyId,
          mfa: !!session.mfaVerified,
        },
        this.jwtSecret
      ),
      accessTokenExpiresAt: new Date(now + ACCESS_TOKEN_TTL_SECONDS * 1000).toISOString(),
      refreshToken,
      refreshTokenExpiresAt: refreshTokenExpiresAt.toISOString(),
      user: sessionUser!,
    };
  }
}
