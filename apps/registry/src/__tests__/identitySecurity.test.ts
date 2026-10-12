// Copyright The Harmoniq Authors
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'crypto';
import { FastifyInstance } from 'fastify';
import type {
  MfaChallengeResponse,
  SessionResponse,
} from '@harmoniq/core/dist/schemas/AuthSchemas';
import { buildApp } from '../app';
import { signAccessToken } from '../auth/tokens';
import { AuthService } from '../services/authService';
import { openSecret } from '../services/crypto';
import { base32Encode, timeStep, totpCode, verifyTotp } from '../services/totp';
import { Fixtures, bearer } from './helpers/fixtures';

describe('TOTP (SES-03)', () => {
  it('matches the RFC 6238 test vector', () => {
    // SHA-1 secret "12345678901234567890"; at T=59 the 8-digit code is 94287082.
    const secret = base32Encode(Buffer.from('12345678901234567890'));
    expect(totpCode(secret, 1)).toBe('287082');
    expect(verifyTotp(secret, '287082', { now: 59_000 })).toBe(1);
    // A step already used is refused (replay); the window is one step each way.
    expect(verifyTotp(secret, '287082', { now: 59_000, lastStep: 1 })).toBeNull();
    expect(verifyTotp(secret, '287082', { now: 59_000 + 90_000 })).toBeNull();
    expect(verifyTotp(secret, 'abcdef', { now: 59_000 })).toBeNull();
  });
});

describe('Identity and session security (SES-01..04)', () => {
  let app: FastifyInstance;
  let fx: Fixtures;
  const run = randomUUID().slice(0, 8);
  const emails: string[] = [];

  const db = () => app.container.systemDb;
  const api = (
    as: string,
    method: 'GET' | 'POST' | 'PUT' | 'DELETE',
    url: string,
    payload?: object
  ) => app.inject({ method, url, payload, headers: bearer(as) });
  const auth = (session?: () => { maxDays: number; idleMinutes: number | null }) =>
    new AuthService(db(), app.config.jwtSecret, app.container.logger, undefined, undefined, {
      session,
      openSecret: (sealed) => openSecret(sealed, app.config.encryptionKey),
    });
  const login = (email: string, service = auth(), provider = 'email') =>
    service.completeLogin(
      { providerUserId: `${provider}-${email}`, email, emailVerified: true },
      provider,
      { ip: '203.0.113.5', userAgent: 'Test Browser/1.0' }
    );
  const person = () => {
    const email = `id-${randomUUID().slice(0, 8)}@test.local`;
    emails.push(email);
    return email;
  };

  beforeAll(async () => {
    app = await buildApp();
    await app.ready();
    fx = new Fixtures(app);
  });

  afterAll(async () => {
    await db().user.deleteMany({ where: { email: { in: emails } } });
    await db().organization.deleteMany({ where: { slug: `mfa-${run}` } });
    await fx.cleanup();
    await app.close();
  });

  it('bounds sessions by the instance setting; org policy only shortens (SES-01)', async () => {
    const email = person();
    const service = auth(() => ({ maxDays: 1, idleMinutes: 30 }));
    const session = (await login(email, service)) as SessionResponse;
    const expires = new Date(session.refreshTokenExpiresAt).getTime();
    // The idle timeout (30 minutes) comes first.
    expect(expires).toBeLessThanOrEqual(Date.now() + 30 * 60_000);
    expect(expires).toBeGreaterThan(Date.now() + 29 * 60_000);

    const user = await db().user.findUniqueOrThrow({ where: { email } });
    expect(await service.sessionLimits(user.id)).toEqual({ maxHours: 24, idleMinutes: 30 });

    // An organization asking for longer changes nothing; shorter wins.
    const org = await db().organization.create({ data: { slug: `mfa-${run}`, name: 'MFA' } });
    await db().organizationMember.create({
      data: { organizationId: org.id, userId: user.id, role: 'org_member' },
    });
    await db().orgPolicy.create({
      data: { organizationId: org.id, sessionMaxHours: 72, idleTimeoutMinutes: 10 },
    });
    expect(await service.sessionLimits(user.id)).toEqual({ maxHours: 24, idleMinutes: 10 });

    // Idle too long: the refresh ends the session.
    await db().refreshToken.updateMany({
      where: { userId: user.id },
      data: { createdAt: new Date(Date.now() - 11 * 60_000) },
    });
    expect(await service.refresh(session.refreshToken)).toBeNull();
    await db().orgPolicy.delete({ where: { organizationId: org.id } });
  });

  it("lists and ends the user's own sessions (SES-02)", async () => {
    const email = person();
    const first = (await login(email)) as SessionResponse;
    const second = (await login(email)) as SessionResponse;
    const other = (await login(person())) as SessionResponse;

    const listed = await api(first.accessToken, 'GET', '/api/me/sessions');
    expect(listed.statusCode).toBe(200);
    const sessions = listed.json().sessions;
    expect(sessions).toHaveLength(2);
    expect(sessions.filter((s: { current: boolean }) => s.current)).toHaveLength(1);
    expect(sessions[0]).toMatchObject({
      provider: 'email',
      ip: '203.0.113.5',
      userAgent: 'Test Browser/1.0',
      mfa: false,
    });
    const currentId = sessions.find((s: { current: boolean }) => s.current).id;
    const secondId = sessions.find((s: { current: boolean }) => !s.current).id;

    // Someone else's session can't be ended.
    expect(
      (await api(other.accessToken, 'DELETE', `/api/me/sessions/${secondId}`)).statusCode
    ).toBe(404);
    expect(
      (await api(first.accessToken, 'DELETE', `/api/me/sessions/${secondId}`)).statusCode
    ).toBe(204);
    // Its access token stops at once, not when it expires.
    expect((await api(second.accessToken, 'GET', '/api/me')).statusCode).toBe(401);
    expect((await api(first.accessToken, 'GET', '/api/me')).statusCode).toBe(200);

    // "Sign out everywhere else" keeps the current session.
    await login(email);
    const ended = await api(first.accessToken, 'DELETE', '/api/me/sessions');
    expect(ended.json().ended).toBe(1);
    expect(
      (await api(first.accessToken, 'GET', '/api/me/sessions'))
        .json()
        .sessions.map((s: { id: string }) => s.id)
    ).toEqual([currentId]);
    expect((await api(other.accessToken, 'GET', '/api/me')).statusCode).toBe(200);
  });

  it('enrols TOTP, then asks for a code at sign-in; recovery codes work once (SES-03)', async () => {
    const email = person();
    const session = (await login(email)) as SessionResponse;
    const setup = await api(session.accessToken, 'POST', '/api/me/mfa/setup');
    expect(setup.statusCode).toBe(200);
    const { secret, otpauthUrl } = setup.json();
    expect(otpauthUrl).toMatch(/^otpauth:\/\/totp\/.+secret=/);

    expect(
      (await api(session.accessToken, 'POST', '/api/me/mfa/enable', { code: '000000' })).statusCode
    ).toBe(400);
    const step = timeStep();
    const enabled = await api(session.accessToken, 'POST', '/api/me/mfa/enable', {
      code: totpCode(secret, step),
      refreshToken: session.refreshToken,
    });
    expect(enabled.statusCode).toBe(200);
    const { recoveryCodes, session: upgraded } = enabled.json();
    expect(recoveryCodes).toHaveLength(10);
    // The enrolling session now counts as verified.
    expect((await api(upgraded.accessToken, 'GET', '/api/me/mfa')).json()).toMatchObject({
      enabled: true,
      sessionVerified: true,
      recoveryCodesLeft: 10,
    });

    // Signing in with one factor gives a challenge, not a session.
    const challenged = (await login(email)) as MfaChallengeResponse;
    expect(challenged).toMatchObject({ mfaRequired: true });
    expect(challenged).not.toHaveProperty('accessToken');
    const verify = (code: string, challenge = challenged.challenge) =>
      app.inject({ method: 'POST', url: '/api/auth/mfa/verify', payload: { challenge, code } });
    expect((await verify('123456')).statusCode).toBe(401);
    // The code used to enrol can't be replayed; the next one works.
    expect((await verify(totpCode(secret, step))).statusCode).toBe(401);
    const ok = await verify(totpCode(secret, step + 1));
    expect(ok.statusCode).toBe(200);
    expect((await api(ok.json().accessToken, 'GET', '/api/me/mfa')).json().sessionVerified).toBe(
      true
    );

    // A recovery code works once.
    const again = (await login(email)) as MfaChallengeResponse;
    expect((await verify(recoveryCodes[0], again.challenge)).statusCode).toBe(200);
    expect((await verify(recoveryCodes[0], again.challenge)).statusCode).toBe(401);
    expect((await api(ok.json().accessToken, 'GET', '/api/me/mfa')).json().recoveryCodesLeft).toBe(
      9
    );
    expect((await verify(totpCode(secret, step + 1), 'not-a-challenge')).statusCode).toBe(401);

    // Tenant SSO sign-ins skip the second step.
    const sso = await login(email, auth(), `oidc:sso-${run}`);
    expect(sso).toHaveProperty('accessToken');

    // Turning it off needs a code.
    expect(
      (await api(upgraded.accessToken, 'DELETE', '/api/me/mfa', { code: '111111' })).statusCode
    ).toBe(403);
    expect(
      (await api(upgraded.accessToken, 'DELETE', '/api/me/mfa', { code: recoveryCodes[1] }))
        .statusCode
    ).toBe(204);
    expect(await login(email)).toHaveProperty('accessToken');
  });

  it("enforces an organization's requireMfa, except for SSO sessions (SES-03)", async () => {
    const owner = await fx.user();
    const { workspace } = await fx.workspace();
    const org = await db().organization.create({
      data: { slug: `mfa-${run}-req`, name: 'Req' },
    });
    await db().workspace.update({ where: { id: workspace.id }, data: { organizationId: org.id } });
    await fx.member(workspace.id, owner.id, 'owner');
    await db().organizationMember.create({
      data: { organizationId: org.id, userId: owner.id, role: 'org_admin' },
    });
    await db().orgPolicy.create({ data: { organizationId: org.id, requireMfa: true } });
    const token = (claims: object) =>
      signAccessToken({ userId: owner.id, email: owner.email, ...claims }, app.config.jwtSecret);

    const plain = await token({ provider: 'email' });
    const denied = await api(plain, 'GET', `/api/workspaces/${workspace.slug}`);
    expect(denied.statusCode).toBe(403);
    expect(denied.json().error.code).toBe('MFA_REQUIRED');
    expect((await api(plain, 'GET', `/api/orgs/${org.slug}`)).json().error.code).toBe(
      'MFA_REQUIRED'
    );
    // Enrolment stays possible.
    expect((await api(plain, 'GET', '/api/me/mfa')).statusCode).toBe(200);

    const verified = await token({ provider: 'email', mfa: true });
    expect((await api(verified, 'GET', `/api/workspaces/${workspace.slug}`)).statusCode).toBe(200);
    expect((await api(verified, 'GET', `/api/orgs/${org.slug}`)).statusCode).toBe(200);

    const sso = await token({ provider: `oidc:${workspace.slug}` });
    expect((await api(sso, 'GET', `/api/workspaces/${workspace.slug}`)).statusCode).toBe(200);

    await db().workspace.update({ where: { id: workspace.id }, data: { organizationId: null } });
    await db().organization.delete({ where: { id: org.id } });
  });

  it('suspends a user: sign-in, refresh, live tokens and their keys stop (SES-04)', async () => {
    const root = await fx.user({ instanceAdmin: true });
    const admin = await fx.session(root);
    const email = person();
    const session = (await login(email)) as SessionResponse;
    const user = await db().user.findUniqueOrThrow({ where: { email } });
    const { workspace } = await fx.workspace();
    await fx.member(workspace.id, user.id, 'owner');
    const key = (
      await api(session.accessToken, 'POST', `/api/workspaces/${workspace.slug}/api-keys`, {
        name: 'ci',
        scopes: ['deploy:write'],
      })
    ).json().key;
    const useKey = () => api(key, 'GET', `/api/workspaces/${workspace.slug}`);
    expect((await useKey()).statusCode).toBe(200);

    expect((await api(admin, 'POST', `/api/admin/users/${root.id}/suspend`, {})).statusCode).toBe(
      400
    );
    const suspended = await api(admin, 'POST', `/api/admin/users/${user.id}/suspend`, {
      reason: 'left the company',
    });
    expect(suspended.statusCode).toBe(200);
    expect((await api(session.accessToken, 'GET', '/api/me')).statusCode).toBe(401);
    expect((await useKey()).statusCode).toBe(401);
    expect(await auth().refresh(session.refreshToken)).toBeNull();
    await expect(login(email)).rejects.toMatchObject({ code: 'account_suspended' });
    const listed = (await api(admin, 'GET', `/api/admin/users?query=${email}`)).json();
    expect(listed.users[0]).toMatchObject({ suspendedReason: 'left the company' });
    expect(
      await db().instanceAuditEvent.count({
        where: { action: 'instance.user_suspend', resourceId: user.id },
      })
    ).toBe(1);

    expect((await api(admin, 'POST', `/api/admin/users/${user.id}/unsuspend`)).statusCode).toBe(
      200
    );
    expect((await useKey()).statusCode).toBe(200);
    expect(await login(email)).toHaveProperty('accessToken');
  });

  it('lets instance admins reset a lost second factor (SES-03)', async () => {
    const root = await fx.user({ instanceAdmin: true });
    const admin = await fx.session(root);
    const email = person();
    const session = (await login(email)) as SessionResponse;
    const { secret } = (await api(session.accessToken, 'POST', '/api/me/mfa/setup')).json();
    await api(session.accessToken, 'POST', '/api/me/mfa/enable', {
      code: totpCode(secret, timeStep()),
    });
    expect(await login(email)).toHaveProperty('mfaRequired');
    const user = await db().user.findUniqueOrThrow({ where: { email } });
    expect((await api(admin, 'DELETE', `/api/admin/users/${user.id}/mfa`)).statusCode).toBe(204);
    expect(await login(email)).toHaveProperty('accessToken');
  });
});
