// Copyright The Harmoniq Authors
// SPDX-License-Identifier: Apache-2.0

import { createHash, randomBytes, randomUUID } from 'crypto';
import { Prisma, PrismaClient, User } from '@prisma/client';
import { ILogger } from '@harmoniq/core/dist/ports/ILogger';
import { IdentityError, IdentityUserInfo } from '@harmoniq/core/dist/ports/IdentityProvider';
import { SessionResponse, SessionUser } from '@harmoniq/core/dist/schemas/AuthSchemas';
import { ACCESS_TOKEN_TTL_SECONDS, signAccessToken } from '../auth/tokens';

const REFRESH_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;
/** SSO-27: how often a session re-checks the IdP session with its refresh token. */
const SSO_RECHECK_MS = 60 * 60 * 1000;

/** Asks the IdP whether a session is still valid; returns its new refresh token or null. */
export type SsoSessionCheck = (provider: string, refreshToken: string) => Promise<string | null>;
// Two tabs refreshing at once both present the same token; the loser is not an attack.
const CONCURRENT_REFRESH_GRACE_MS = 10_000;

const hashToken = (raw: string) => createHash('sha256').update(raw).digest('hex');

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
    }
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

        // Pending invitations are addressed to this (now verified) email: accept them.
        await tx.workspaceMember.updateMany({
          where: { userId: user.id, joinedAt: null },
          data: { joinedAt: now },
        });

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
