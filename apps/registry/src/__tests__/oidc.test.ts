// Copyright The Harmoniq Authors
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createHash, randomBytes } from 'crypto';
import { FastifyInstance } from 'fastify';
import { buildApp } from '../app';
import { Fixtures, bearer } from './helpers/fixtures';
import { mockIdp } from './helpers/mockOidc';

describe('OIDC single sign-on (M4.4, SSO-01..08, 21..28)', () => {
  let app: FastifyInstance;
  let fx: Fixtures;
  let idp: Awaited<ReturnType<typeof mockIdp>>;
  let ws: string;
  let workspaceId: string;
  let owner: string;
  let ownerUserId: string;
  const redirectUri = 'http://localhost:3000/api/auth/callback/oidc';
  const domain = `sso-${Date.now()}.example.com`;

  const api = (
    as: string | null,
    method: 'GET' | 'POST' | 'PUT' | 'DELETE',
    url: string,
    payload?: object
  ) => app.inject({ method, url, payload, headers: as ? bearer(as) : {} });
  const config = (extra: object = {}) => ({
    issuer: idp.issuer,
    clientId: 'harmoniq',
    clientSecret: 'idp-secret-1234',
    roleMapping: { engineers: 'developer', 'platform-admins': 'admin' },
    trustedDomains: [domain],
    defaultRole: 'viewer',
    ...extra,
  });

  /** The whole browser dance: start, log in at the IdP, callback. */
  async function ssoLogin(user: Record<string, unknown>, opts: { verifier?: string } = {}) {
    const verifier = randomBytes(32).toString('base64url');
    const codeChallenge = createHash('sha256').update(verifier).digest('base64url');
    const start = await api(null, 'POST', `/api/auth/oidc:${ws}/start`, {
      state: randomBytes(16).toString('base64url'),
      codeChallenge,
      redirectUri,
    });
    expect(start.statusCode).toBe(200);
    const code = idp.authorize(start.json().authorizationUrl, user);
    return api(null, 'POST', `/api/auth/oidc:${ws}/callback`, {
      code,
      codeVerifier: opts.verifier ?? verifier,
      redirectUri,
    });
  }
  const member = async (email: string) =>
    app.container.systemDb.workspaceMember.findFirst({
      where: { workspaceId, user: { email } },
    });

  beforeAll(async () => {
    idp = await mockIdp();
    app = await buildApp();
    await app.ready();
    fx = new Fixtures(app);
    const { workspace } = await fx.workspace();
    ws = workspace.slug;
    workspaceId = workspace.id;
    const o = await fx.user();
    ownerUserId = o.id;
    await fx.member(workspace.id, o.id, 'owner');
    owner = await fx.session(o);
  });

  afterAll(async () => {
    await app.container.systemDb.user.deleteMany({ where: { email: { endsWith: `@${domain}` } } });
    await fx.cleanup();
    await app.close();
    await idp.close();
  });

  it('validates and stores the config, never returning the secret (SSO-03/04)', async () => {
    const broken = await api(owner, 'PUT', `/api/workspaces/${ws}/sso/oidc`, {
      ...config(),
      issuer: 'http://127.0.0.1:9/nothing',
    });
    expect(broken.statusCode).toBe(400);
    const res = await api(owner, 'PUT', `/api/workspaces/${ws}/sso/oidc`, config());
    expect(res.statusCode).toBe(200);
    expect(res.json().oidc).toMatchObject({ providerId: `oidc:${ws}`, clientId: 'harmoniq' });
    expect(res.json().oidc.clientSecret).not.toContain('idp-secret');
    const stored = await app.container.systemDb.workspaceConfig.findUnique({
      where: { workspaceId },
    });
    expect(JSON.stringify(stored?.oidcConfig)).not.toContain('idp-secret');

    const found = await api(null, 'GET', `/api/auth/sso/discover?email=jane@${domain}`);
    expect(found.json()).toMatchObject({ provider: `oidc:${ws}` });
    expect((await api(null, 'GET', '/api/auth/sso/discover?email=x@other.org')).statusCode).toBe(
      404
    );
  });

  it('signs in with PKCE, creates the user and maps groups to roles (SSO-01/05/06/07/21/23/28)', async () => {
    const email = `ana@${domain}`;
    const res = await ssoLogin({
      sub: 'idp-ana',
      email,
      email_verified: true,
      name: 'Ana',
      groups: ['engineers', 'platform-admins'],
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().user.email).toBe(email);
    expect((await member(email))?.role).toBe('admin'); // most permissive match
    const audit = await app.container.systemDb.auditEvent.findFirst({
      where: { workspaceId, action: 'auth.sso_login' },
    });
    expect(audit?.metadata).toMatchObject({ email, role: 'admin', change: 'joined' });

    // Groups change at the IdP: the role follows on the next login.
    await ssoLogin({ sub: 'idp-ana', email, email_verified: true, groups: ['engineers'] });
    expect((await member(email))?.role).toBe('developer');
  });

  it('joins trusted-domain users with the default role, and never demotes owners (SSO-22)', async () => {
    const email = `bo@${domain}`;
    await ssoLogin({ sub: 'idp-bo', email }); // no email_verified, but a trusted domain
    expect((await member(email))?.role).toBe('viewer');

    const ownerEmail = (
      await app.container.systemDb.user.findUniqueOrThrow({ where: { id: ownerUserId } })
    ).email;
    await ssoLogin({
      sub: 'idp-owner',
      email: ownerEmail,
      email_verified: true,
      groups: ['engineers'],
    });
    const ownerMember = await app.container.systemDb.workspaceMember.findFirst({
      where: { workspaceId, userId: ownerUserId },
    });
    expect(ownerMember?.role).toBe('owner');
  });

  it('refuses tampered logins (SSO-05)', async () => {
    const user = { sub: 'idp-eve', email: `eve@${domain}`, email_verified: true };
    expect(
      (await ssoLogin(user, { verifier: 'not-the-verifier-' + 'x'.repeat(30) })).statusCode
    ).toBe(401);
    idp.state.wrongNonce = true;
    const res = await ssoLogin(user);
    idp.state.wrongNonce = false;
    expect(res.statusCode).toBe(401);
    expect(res.json().error.message).toMatch(/nonce/);
  });

  it('forces SSO for members, with owners exempt (SSO-26)', async () => {
    const email = `cy@${domain}`;
    const sso = (
      await ssoLogin({ sub: 'idp-cy', email, email_verified: true, groups: ['engineers'] })
    ).json().accessToken;
    // The same person through another sign-in method.
    const cy = await app.container.systemDb.user.findFirstOrThrow({ where: { email } });
    const other = await fx.session(cy);

    await api(owner, 'PUT', `/api/workspaces/${ws}/sso/oidc`, {
      ...config(),
      clientSecret: undefined,
      forceSso: true,
    });
    const denied = await api(other, 'GET', `/api/workspaces/${ws}/modules`);
    expect(denied.statusCode).toBe(403);
    expect(denied.json().error.code).toBe('SSO_REQUIRED');
    expect((await api(sso, 'GET', `/api/workspaces/${ws}/modules`)).statusCode).toBe(200);
    expect((await api(owner, 'GET', `/api/workspaces/${ws}/modules`)).statusCode).toBe(200);
    await api(owner, 'PUT', `/api/workspaces/${ws}/sso/oidc`, {
      ...config(),
      clientSecret: undefined,
      forceSso: false,
    });
  });

  it('ends the session when the IdP session ends (SSO-08/27)', async () => {
    const login = (
      await ssoLogin({ sub: 'idp-di', email: `di@${domain}`, email_verified: true })
    ).json();
    const refresh = (refreshToken: string) =>
      app.inject({ method: 'POST', url: '/api/auth/refresh', payload: { refreshToken } });
    const age = () =>
      app.container.systemDb.refreshToken.updateMany({
        where: { user: { email: `di@${domain}` } },
        data: { ssoCheckedAt: new Date(Date.now() - 2 * 3_600_000) },
      });

    await age();
    const ok = await refresh(login.refreshToken);
    expect(ok.statusCode).toBe(200);

    idp.refreshTokens.clear(); // the IdP revoked the session
    await age();
    expect((await refresh(ok.json().refreshToken)).statusCode).toBe(401);
  });
});
