// Copyright The Harmoniq Authors
// SPDX-License-Identifier: Apache-2.0
/* eslint-disable no-restricted-syntax -- MT-09: the signed-in user's own account (User is global, not tenant data) */

import { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  BadRequestError,
  ConflictError,
  ForbiddenError,
  NotFoundError,
} from '@harmoniq/core/dist/errors/AppError';
import type { AuthService } from '../services/authService';
import { openSecret, sealSecret } from '../services/crypto';
import {
  hashRecoveryCode,
  newRecoveryCodes,
  newTotpSecret,
  otpauthUrl,
  verifyTotp,
} from '../services/totp';

const CodeSchema = z.object({ code: z.string().trim().min(6).max(32) });
const EnableSchema = z.object({
  code: z
    .string()
    .trim()
    .regex(/^\d{6}$/, 'A 6-digit code'),
  /** The current session, upgraded to `mfa` once enrolled (the dashboard sends it). */
  refreshToken: z.string().min(1).max(200).optional(),
});

/**
 * SES-02/03: the signed-in user's own sessions and second factor (`/api/me/*`). Only for
 * user sessions; each acts on the caller alone.
 */
export function accountRoutes(fastify: FastifyInstance, auth: AuthService) {
  const { systemDb, logger, settings } = fastify.container;
  const { encryptionKey } = fastify.config;
  const user = { preHandler: fastify.authenticate };

  const me = (request: FastifyRequest) => {
    const principal = request.principal!;
    if (principal.type !== 'user') throw new BadRequestError('This needs a user session');
    return principal;
  };
  const client = (request: FastifyRequest) => ({
    ip: request.ip,
    userAgent: request.headers['user-agent'],
  });

  // ─── Sessions (SES-02) ────────────────────────────────────────────────────

  fastify.get('/api/me/sessions', user, async (request) => {
    const principal = me(request);
    return { sessions: await auth.listSessions(principal.id, principal.sessionId) };
  });

  fastify.delete<{ Params: { id: string } }>(
    '/api/me/sessions/:id',
    user,
    async (request, reply) => {
      const principal = me(request);
      if (!(await auth.endSession(principal.id, request.params.id))) {
        throw new NotFoundError('Session not found');
      }
      fastify.forgetSession(request.params.id);
      logger.info(`auth.session_ended user=${principal.id} reason=user`);
      return reply.code(204).send();
    }
  );

  /** Ends every other session (`?includeCurrent=true`: this one too). */
  fastify.delete<{ Querystring: { includeCurrent?: string } }>(
    '/api/me/sessions',
    user,
    async (request) => {
      const principal = me(request);
      const keep = request.query.includeCurrent === 'true' ? undefined : principal.sessionId;
      const sessions = await auth.listSessions(principal.id);
      const ended = await auth.endSessions(principal.id, keep);
      for (const s of sessions) if (s.id !== keep) fastify.forgetSession(s.id);
      logger.info(`auth.sessions_ended user=${principal.id} count=${ended}`);
      return { ended };
    }
  );

  // ─── Multi-factor authentication (SES-03) ─────────────────────────────────

  const account = (id: string) => systemDb.user.findUniqueOrThrow({ where: { id } });

  fastify.get('/api/me/mfa', user, async (request) => {
    const u = await account(me(request).id);
    return {
      enabled: !!u.mfaEnabledAt,
      enabledAt: u.mfaEnabledAt?.toISOString() ?? null,
      recoveryCodesLeft: u.mfaEnabledAt ? u.mfaRecoveryCodes.length : 0,
      // This session passed a second factor.
      sessionVerified: !!me(request).mfa,
    };
  });

  /** A new secret to scan (replaces an unfinished setup); MFA is on after `enable`. */
  fastify.post('/api/me/mfa/setup', user, async (request) => {
    const principal = me(request);
    const u = await account(principal.id);
    if (u.mfaEnabledAt) throw new ConflictError('MFA is already on; turn it off first');
    const secret = newTotpSecret();
    await systemDb.user.update({
      where: { id: u.id },
      data: { mfaSecretSealed: sealSecret(secret, encryptionKey), mfaLastStep: null },
    });
    return { secret, otpauthUrl: otpauthUrl(secret, u.email, settings.branding().name) };
  });

  /** Confirms the app works with a code; returns recovery codes (shown once). */
  fastify.post('/api/me/mfa/enable', user, async (request) => {
    const principal = me(request);
    const body = EnableSchema.parse(request.body);
    const u = await account(principal.id);
    if (u.mfaEnabledAt) throw new ConflictError('MFA is already on');
    if (!u.mfaSecretSealed) throw new ConflictError('Start the setup first');
    const step = verifyTotp(openSecret(u.mfaSecretSealed, encryptionKey), body.code);
    if (step === null)
      throw new BadRequestError('That code is not valid; check the app and the clock');
    const recoveryCodes = newRecoveryCodes();
    await systemDb.user.update({
      where: { id: u.id },
      data: {
        mfaEnabledAt: new Date(),
        mfaLastStep: step,
        mfaRecoveryCodes: recoveryCodes.map(hashRecoveryCode),
      },
    });
    logger.info(`auth.mfa_enabled user=${u.id}`);
    const session = body.refreshToken
      ? await auth.upgradeSession(u.id, body.refreshToken, client(request))
      : null;
    return { enabled: true, recoveryCodes, session };
  });

  /** New recovery codes (the old ones stop working); needs a current code. */
  fastify.post('/api/me/mfa/recovery-codes', user, async (request) => {
    const { code } = CodeSchema.parse(request.body);
    const u = await account(me(request).id);
    if (!u.mfaEnabledAt) throw new ConflictError('MFA is off');
    if (!(await auth.checkSecondFactor(u, code)))
      throw new ForbiddenError('That code is not valid');
    const recoveryCodes = newRecoveryCodes();
    await systemDb.user.update({
      where: { id: u.id },
      data: { mfaRecoveryCodes: recoveryCodes.map(hashRecoveryCode) },
    });
    logger.info(`auth.mfa_recovery_codes_replaced user=${u.id}`);
    return { recoveryCodes };
  });

  /** Turns MFA off; needs a current code or a recovery code. */
  fastify.delete('/api/me/mfa', user, async (request, reply) => {
    const { code } = CodeSchema.parse(request.body ?? {});
    const u = await account(me(request).id);
    if (!u.mfaEnabledAt) throw new ConflictError('MFA is off');
    if (!(await auth.checkSecondFactor(u, code)))
      throw new ForbiddenError('That code is not valid');
    await systemDb.user.update({
      where: { id: u.id },
      data: {
        mfaEnabledAt: null,
        mfaSecretSealed: null,
        mfaRecoveryCodes: [],
        mfaLastStep: null,
      },
    });
    logger.info(`auth.mfa_disabled user=${u.id}`);
    return reply.code(204).send();
  });
}
