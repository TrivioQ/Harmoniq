// Copyright The Harmoniq Authors
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'crypto';
import { FastifyInstance } from 'fastify';
import { buildApp } from '../app';
import { AuthService } from '../services/authService';
import { signAccessToken } from '../auth/tokens';
import { Fixtures, bearer } from './helpers/fixtures';

/** HARMONIQ_AUTH_METHODS: the environment decides which sign-in methods exist at all. */
describe('Sign-in methods from the environment', () => {
  let app: FastifyInstance;
  let fx: Fixtures;
  let root: string;
  const saved = {
    methods: process.env.HARMONIQ_AUTH_METHODS,
    dev: process.env.HARMONIQ_DEV_LOGIN,
  };

  const api = (as: string | null, method: 'GET' | 'PUT', url: string, payload?: object) =>
    app.inject({ method, url, payload, headers: as ? bearer(as) : {} });
  const providerIds = async () =>
    ((await api(null, 'GET', '/api/auth/providers')).json().providers as { id: string }[]).map(
      (p) => p.id
    );
  const resetSettings = async () => {
    await app.container.systemDb.instanceConfig.deleteMany({
      where: { key: { startsWith: 'settings.' } },
    });
    await app.container.settings.reload();
  };
  const restore = (key: string, value: string | undefined) => {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  };

  beforeAll(async () => {
    process.env.HARMONIQ_AUTH_METHODS = 'email,sso-oidc';
    delete process.env.HARMONIQ_DEV_LOGIN;
    app = await buildApp();
    await app.ready();
    fx = new Fixtures(app);
    await resetSettings();
    root = await fx.session(await fx.user({ instanceAdmin: true }));
  });

  afterAll(async () => {
    restore('HARMONIQ_AUTH_METHODS', saved.methods);
    restore('HARMONIQ_DEV_LOGIN', saved.dev);
    await resetSettings();
    await fx.cleanup();
    await app.close();
  });

  it('offers only the allowed methods, and no development login', async () => {
    expect(await providerIds()).toEqual(['email']);
    const dev = await app.inject({
      method: 'POST',
      url: '/api/auth/dev/login',
      payload: { email: 'x@example.com' },
    });
    expect(dev.statusCode).toBe(404);
  });

  it('shows forbidden switches as locked; the admin panel cannot turn them on', async () => {
    const view = (await api(root, 'GET', '/api/admin/settings')).json().auth;
    expect(view.locked).toEqual(['github', 'saml']);
    expect(view.allowedMethods).toEqual(['email', 'sso-oidc']);
    expect(view.methodsFromEnvironment).toBe(true);
    expect(view.value.github.enabled).toBe(false);
    expect(view.value.saml.enabled).toBe(false);

    const refused = await api(root, 'PUT', '/api/admin/settings/auth', {
      github: { enabled: true, clientId: 'id', clientSecret: 'secret' },
      saml: { enabled: true },
    });
    expect(refused.statusCode).toBe(400);
    expect(refused.json().error.message).toContain('github, saml');
    expect(await providerIds()).not.toContain('github');

    // Turning allowed methods off still works.
    const off = await api(root, 'PUT', '/api/admin/settings/auth', {
      email: { enabled: false },
      github: { enabled: false },
      saml: { enabled: false },
    });
    expect(off.statusCode).toBe(200);
    expect(await providerIds()).toEqual([]);
    await resetSettings();
  });

  it('ends sessions from a method that is not allowed', async () => {
    const user = await fx.user();
    const as = (provider: string) =>
      signAccessToken({ userId: user.id, email: user.email, provider }, app.config.jwtSecret);
    const me = async (token: string) => (await api(token, 'GET', '/api/me')).statusCode;

    expect(await me(await as('email'))).toBe(200);
    expect(await me(await as('oidc:some-workspace'))).toBe(200); // sso-oidc is allowed
    expect(await me(await as('github'))).toBe(401);
    expect(await me(await as('saml:some-workspace'))).toBe(401);
    expect(await me(await as('dev'))).toBe(401);
  });

  it('refuses to refresh such a session and revokes it', async () => {
    // A GitHub session from before the method was removed from the environment.
    const auth = new AuthService(
      app.container.systemDb,
      app.config.jwtSecret,
      app.container.logger
    );
    const email = `gh-${randomUUID().slice(0, 8)}@example.com`;
    const session = await auth.completeLogin(
      { providerUserId: randomUUID(), email, emailVerified: true },
      'github'
    );
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/refresh',
      payload: { refreshToken: session.refreshToken },
    });
    expect(res.statusCode).toBe(401);
    const tokens = await app.container.systemDb.refreshToken.findMany({
      where: { user: { email } },
    });
    expect(tokens.every((t) => t.revokedAt)).toBe(true);
    await app.container.systemDb.user.deleteMany({ where: { email } });
  });
});
