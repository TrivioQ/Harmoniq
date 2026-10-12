// Copyright The Harmoniq Authors
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'crypto';
import { readFileSync } from 'fs';
import { join } from 'path';
import { FastifyInstance } from 'fastify';
import type { SessionResponse } from '@harmoniq/core/dist/schemas/AuthSchemas';
import { buildApp } from '../app';
import { signAccessToken } from '../auth/tokens';
import { ADMIN_ROLES, requirementOf, roleAllows } from '../services/adminAccess';
import { AuthService } from '../services/authService';
import { openSecret } from '../services/crypto';
import { timeStep, totpCode } from '../services/totp';
import { Fixtures, bearer } from './helpers/fixtures';

/** Every `/api/admin` route, from the OpenAPI document generated from the routes. */
const adminRoutes = () => {
  const doc = JSON.parse(
    readFileSync(join(__dirname, '../../../../docs/openapi.json'), 'utf8')
  ) as { paths: Record<string, Record<string, unknown>> };
  return Object.entries(doc.paths)
    .filter(([path]) => path.startsWith('/api/admin') && !path.startsWith('/api/admin/setup'))
    .flatMap(([path, ops]) =>
      Object.keys(ops).map((m) => ({
        method: m.toUpperCase(),
        url: path.replace(/\{(\w+)\}/g, ':$1'),
      }))
    );
};

describe('Instance admin roles (INST-31)', () => {
  it('maps every admin route to a capability; writes default to owners', () => {
    const routes = adminRoutes();
    expect(routes.length).toBeGreaterThan(30);
    for (const { method, url } of routes) {
      const need = requirementOf(method, url, { key: 'branding' });
      if (method === 'GET') expect(need.capability, url).toBe('read');
      // Every role reads; only owners do what isn't listed.
      for (const role of ADMIN_ROLES) {
        if (need.capability === 'read') expect(roleAllows(role, 'read')).toBe(true);
      }
      expect(roleAllows('instance_owner', need.capability), `${method} ${url}`).toBe(true);
    }
    expect(requirementOf('PUT', '/api/admin/settings/:key', { key: 'auth' }).destructive).toBe(
      true
    );
    expect(requirementOf('PUT', '/api/admin/settings/:key', { key: 'branding' }).destructive).toBe(
      false
    );
    expect(requirementOf('DELETE', '/api/admin/workspaces/:slug').destructive).toBe(true);
    expect(requirementOf('POST', '/api/admin/some-new-thing').capability).toBe('owner');
  });
});

describe('Instance admin access (INST-31..33)', () => {
  let app: FastifyInstance;
  let fx: Fixtures;
  const run = randomUUID().slice(0, 8);
  const db = () => app.container.systemDb;
  type Method = 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH';
  const api = (as: string, method: Method, url: string, payload?: object) =>
    app.inject({ method, url, payload, headers: bearer(as) });
  /** A session of an instance admin with this role. */
  const adminAs = async (role: string, claims: object = {}) => {
    const user = await fx.user({ instanceAdmin: true });
    await db().instanceAdmin.update({ where: { userId: user.id }, data: { role } });
    return {
      user,
      token: await signAccessToken(
        { userId: user.id, email: user.email, reauthAt: Date.now(), ...claims },
        app.config.jwtSecret
      ),
    };
  };

  beforeAll(async () => {
    app = await buildApp();
    await app.ready();
    fx = new Fixtures(app);
  });

  afterAll(async () => {
    await db().instanceApiKey.deleteMany({ where: { name: { startsWith: `test-${run}` } } });
    await db().instanceAdminInvitation.deleteMany({ where: { email: { contains: run } } });
    await db().user.deleteMany({ where: { email: { contains: run } } });
    await fx.cleanup();
    await app.close();
  });

  it('lets each role do what it may, and nothing more', async () => {
    const { workspace } = await fx.workspace();
    const target = await fx.user();
    const [support, billing, operator, owner] = await Promise.all(
      ['instance_support', 'instance_billing', 'instance_operator', 'instance_owner'].map((r) =>
        adminAs(r)
      )
    );
    const W = `/api/admin/workspaces/${workspace.slug}`;
    const status = async (as: string, method: Method, url: string, body?: object) =>
      (await api(as, method, url, body)).statusCode;

    // Everyone reads.
    for (const a of [support, billing, operator, owner]) {
      expect(await status(a.token, 'GET', '/api/admin/users')).toBe(200);
    }
    // Support: sessions only.
    expect(
      await status(support.token, 'POST', `/api/admin/users/${target.id}/revoke-sessions`)
    ).toBe(200);
    expect(await status(support.token, 'PUT', `${W}/plan`, { plan: 'startup' })).toBe(403);
    // Billing: plans only.
    expect(await status(billing.token, 'PUT', `${W}/plan`, { plan: 'startup' })).toBe(200);
    expect(await status(billing.token, 'POST', `${W}/suspend`, { reason: 'x' })).toBe(403);
    // Operator: tenants, plans, users; not settings or admins.
    expect(await status(operator.token, 'POST', `${W}/suspend`, { reason: 'x' })).toBe(200);
    expect(await status(operator.token, 'POST', `${W}/unsuspend`)).toBe(200);
    expect(await status(operator.token, 'PUT', '/api/admin/settings/branding', { name: 'X' })).toBe(
      403
    );
    expect(
      await status(operator.token, 'POST', '/api/admin/admins', { email: `x-${run}@test.local` })
    ).toBe(403);
    // Owner: settings.
    expect(
      await status(owner.token, 'PUT', '/api/admin/settings/branding', { name: 'Harmoniq' })
    ).toBe(200);
    await api(owner.token, 'DELETE', '/api/admin/settings/branding');
  });

  it('needs a recent re-authentication for destructive actions (INST-32)', async () => {
    const stale = await adminAs('instance_owner', { reauthAt: Date.now() - 11 * 60_000 });
    const { workspace } = await fx.workspace();
    const refused = await api(
      stale.token,
      'DELETE',
      `/api/admin/workspaces/${workspace.slug}?confirm=${workspace.slug}`
    );
    expect(refused.statusCode).toBe(403);
    expect(refused.json().error.code).toBe('REAUTH_REQUIRED');
    // Not destructive: fine.
    expect((await api(stale.token, 'GET', '/api/admin/users')).statusCode).toBe(200);

    // Re-authenticate with a code: the new token passes.
    const auth = new AuthService(
      db(),
      app.config.jwtSecret,
      app.container.logger,
      undefined,
      undefined,
      {
        openSecret: (sealed) => openSecret(sealed, app.config.encryptionKey),
      }
    );
    const email = `reauth-${run}@test.local`;
    const session = (await auth.completeLogin(
      { providerUserId: email, email, emailVerified: true },
      'email'
    )) as SessionResponse;
    const user = await db().user.findUniqueOrThrow({ where: { email } });
    await db().instanceAdmin.create({ data: { userId: user.id, grantedBy: 'test' } });
    const { secret } = (await api(session.accessToken, 'POST', '/api/me/mfa/setup')).json();
    const step = timeStep();
    await api(session.accessToken, 'POST', '/api/me/mfa/enable', { code: totpCode(secret, step) });
    const old = await signAccessToken(
      { userId: user.id, email, reauthAt: Date.now() - 20 * 60_000 },
      app.config.jwtSecret
    );
    expect(
      (
        await api(old, 'POST', '/api/auth/reauth', {
          code: '000000',
          refreshToken: session.refreshToken,
        })
      ).statusCode
    ).toBe(401);
    const fresh = await api(old, 'POST', '/api/auth/reauth', {
      code: totpCode(secret, step + 1),
      refreshToken: session.refreshToken,
    });
    expect(fresh.statusCode).toBe(200);
    const deleted = await api(
      fresh.json().accessToken,
      'DELETE',
      `/api/admin/workspaces/${workspace.slug}?confirm=${workspace.slug}`
    );
    expect(deleted.statusCode).toBe(204);
  });

  it('caps admin sessions sooner (INST-32)', async () => {
    const auth = new AuthService(
      db(),
      app.config.jwtSecret,
      app.container.logger,
      undefined,
      undefined,
      {
        session: () => ({ maxDays: 30, idleMinutes: null, adminMaxHours: 8 }),
      }
    );
    const admin = await fx.user({ instanceAdmin: true });
    const plain = await fx.user();
    expect((await auth.sessionLimits(admin.id)).maxHours).toBe(8);
    expect((await auth.sessionLimits(plain.id)).maxHours).toBe(720);
  });

  it('issues instance keys that never reach tenants (INST-33)', async () => {
    const owner = await adminAs('instance_owner');
    const create = (scopes: string[], extra: object = {}) =>
      api(owner.token, 'POST', '/api/admin/api-keys', { name: `test-${run}`, scopes, ...extra });
    const read = (await create(['instance:read'])).json();
    const write = (await create(['instance:admin'])).json();
    expect(read.key).toMatch(/^hq_inst_/);

    expect((await api(read.key, 'GET', '/api/admin/health')).statusCode).toBe(200);
    const { workspace } = await fx.workspace();
    expect(
      (
        await api(read.key, 'POST', `/api/admin/workspaces/${workspace.slug}/suspend`, {
          reason: 'x',
        })
      ).statusCode
    ).toBe(403);
    expect(
      (
        await api(write.key, 'POST', `/api/admin/workspaces/${workspace.slug}/suspend`, {
          reason: 'automation',
        })
      ).statusCode
    ).toBe(200);
    expect(
      await db().instanceAuditEvent.findFirst({
        where: { action: 'instance.workspace_suspend', resourceId: workspace.id },
        orderBy: { createdAt: 'desc' },
      })
    ).toMatchObject({ actorType: 'apiKey', actorId: write.id });
    // What the Terraform provider does: read and set plans and settings.
    const plan = `/api/admin/workspaces/${workspace.slug}/plan`;
    expect((await api(read.key, 'GET', plan)).json()).toMatchObject({
      slug: workspace.slug,
      plan: 'hobby',
      overrides: null,
    });
    expect(
      (
        await api(write.key, 'PUT', plan, {
          plan: 'startup',
          overrides: { limits: { modules: 50 } },
        })
      ).statusCode
    ).toBe(200);
    expect((await api(read.key, 'GET', plan)).json()).toMatchObject({
      plan: 'startup',
      overrides: { limits: { modules: 50 } },
    });
    expect((await api(read.key, 'GET', '/api/admin/workspaces/nope-nope/plan')).statusCode).toBe(
      404
    );
    expect((await api(write.key, 'PUT', '/api/admin/settings/gc', { keepVersions: 7 })).json())
      .toMatchObject({ source: 'database', value: { keepVersions: 7 } });
    expect((await api(write.key, 'DELETE', '/api/admin/settings/gc')).statusCode).toBe(204);
    // No escalation, no tenants.
    expect(
      (
        await api(write.key, 'POST', '/api/admin/api-keys', {
          name: 'x',
          scopes: ['instance:admin'],
        })
      ).statusCode
    ).toBe(403);
    expect((await api(write.key, 'GET', `/api/workspaces/${workspace.slug}`)).statusCode).toBe(403);
    expect((await api(write.key, 'GET', '/api/orgs')).statusCode).toBe(403);
    expect((await api(write.key, 'GET', '/api/me')).statusCode).toBe(403);

    expect((await api(owner.token, 'DELETE', `/api/admin/api-keys/${read.id}`)).statusCode).toBe(
      204
    );
    expect((await api(read.key, 'GET', '/api/admin/health')).statusCode).toBe(401);
    const expired = (
      await create(['instance:read'], { expiresAt: new Date(Date.now() - 1000).toISOString() })
    ).json();
    expect((await api(expired.key, 'GET', '/api/admin/health')).statusCode).toBe(401);
  });

  it('invites admins by email; their next sign-in accepts, not a tenant SSO one (INST-31)', async () => {
    const owner = await adminAs('instance_owner');
    const email = `new-admin-${run}@test.local`;
    const invited = await api(owner.token, 'POST', '/api/admin/admins', {
      email,
      role: 'instance_support',
    });
    expect(invited.statusCode).toBe(202);
    expect((await api(owner.token, 'GET', '/api/admin/admins')).json().invitations).toEqual(
      expect.arrayContaining([expect.objectContaining({ email, role: 'instance_support' })])
    );
    const auth = new AuthService(db(), app.config.jwtSecret, app.container.logger);
    await auth.completeLogin(
      { providerUserId: `sso-${email}`, email, emailVerified: true },
      'oidc:some-ws'
    );
    const user = await db().user.findUniqueOrThrow({ where: { email } });
    expect(await db().instanceAdmin.findUnique({ where: { userId: user.id } })).toBeNull();
    await auth.completeLogin({ providerUserId: email, email, emailVerified: true }, 'email');
    expect(await db().instanceAdmin.findUnique({ where: { userId: user.id } })).toMatchObject({
      role: 'instance_support',
      revokedAt: null,
    });
  });
});

describe('Admin MFA and network (INST-32)', () => {
  it('needs MFA (or instance SSO) and an allowed network when configured', async () => {
    const saved = { ...process.env };
    process.env.HARMONIQ_ADMIN_REQUIRE_MFA = '1';
    process.env.HARMONIQ_ADMIN_IP_ALLOWLIST = '203.0.113.0/24';
    const app = await buildApp();
    await app.ready();
    const fx = new Fixtures(app);
    try {
      const user = await fx.user({ instanceAdmin: true });
      const token = (claims: object) =>
        signAccessToken({ userId: user.id, email: user.email, ...claims }, app.config.jwtSecret);
      const get = async (claims: object, remoteAddress = '203.0.113.5') =>
        app.inject({
          method: 'GET',
          url: '/api/admin/users',
          headers: bearer(await token(claims)),
          remoteAddress,
        });
      const plain = await get({ provider: 'email' });
      expect(plain.statusCode).toBe(403);
      expect(plain.json().error.code).toBe('ADMIN_MFA_REQUIRED');
      expect((await get({ provider: 'email', mfa: true })).statusCode).toBe(200);
      const outside = await get({ provider: 'email', mfa: true }, '198.51.100.9');
      expect(outside.json().error.code).toBe('IP_NOT_ALLOWED');
    } finally {
      process.env = saved;
      await fx.cleanup();
      await app.close();
    }
  });
});
