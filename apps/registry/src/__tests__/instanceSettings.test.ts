// Copyright The Harmoniq Authors
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { FastifyInstance } from 'fastify';
import { buildApp } from '../app';
import { ConsoleMailer } from '../adapters/mail/ConsoleMailer';
import { Fixtures, bearer } from './helpers/fixtures';

describe('Instance settings (M4.8b, INST-11..18)', () => {
  let app: FastifyInstance;
  let fx: Fixtures;
  let root: string;
  let rootEmail: string;
  let owner: string;
  let ws: string;

  const api = (
    as: string | null,
    method: 'GET' | 'POST' | 'PUT' | 'DELETE',
    url: string,
    payload?: object
  ) => app.inject({ method, url, payload, headers: as ? bearer(as) : {} });
  const put = (key: string, value: object) => api(root, 'PUT', `/api/admin/settings/${key}`, value);
  const providers = async () =>
    ((await api(null, 'GET', '/api/auth/providers')).json().providers as { id: string }[]).map(
      (p) => p.id
    );
  const resetAll = async () => {
    await app.container.systemDb.instanceConfig.deleteMany({
      where: { key: { startsWith: 'settings.' } },
    });
    await app.container.settings.reload();
  };

  beforeAll(async () => {
    app = await buildApp();
    await app.ready();
    fx = new Fixtures(app);
    await resetAll();
    const [r, o] = await Promise.all([fx.user({ instanceAdmin: true }), fx.user()]);
    rootEmail = r.email;
    [root, owner] = await Promise.all([fx.session(r), fx.session(o)]);
    const { workspace } = await fx.workspace();
    ws = workspace.slug;
    await fx.member(workspace.id, o.id, 'owner');
  });

  afterAll(async () => {
    await resetAll();
    await fx.cleanup();
    await app.close();
  });

  it('starts from the environment; only instance admins see or change it', async () => {
    const view = (await api(root, 'GET', '/api/admin/settings')).json();
    for (const key of ['storage', 'email', 'auth', 'branding']) {
      expect(view[key].source).toBe('environment');
    }
    expect((await api(owner, 'GET', '/api/admin/settings')).statusCode).toBe(403);
    expect((await put('nope', {})).statusCode).toBe(404);
    expect((await api(null, 'GET', '/api/instance')).json()).toEqual({
      branding: { name: 'Harmoniq' },
    });
  });

  it('turns sign-in methods off for everyone (INST-13)', async () => {
    expect(await providers()).toContain('email');
    // The admin keeps a way in (INST-23): GitHub, which they have signed in with.
    const rootUser = await app.container.systemDb.user.findUniqueOrThrow({
      where: { email: rootEmail },
    });
    await app.container.systemDb.identity.create({
      data: {
        userId: rootUser.id,
        provider: 'github',
        providerUserId: rootUser.id,
        email: rootEmail,
      },
    });
    const saved = await put('auth', {
      email: { enabled: false },
      saml: { enabled: false },
      github: { enabled: true, clientId: 'gh-id', clientSecret: 'gh-secret' },
    });
    expect(saved.statusCode).toBe(200);
    expect(await providers()).not.toContain('email');
    const request = await api(null, 'POST', '/api/auth/email/request', {
      email: 'x@example.com',
      redirectUri: 'http://localhost:3000/auth/verify',
      nonce: 'n'.repeat(16),
    });
    expect(request.statusCode).toBe(404);

    // Workspaces can't set up (or use) a disabled protocol.
    const saml = await api(owner, 'PUT', `/api/workspaces/${ws}/sso/saml`, {
      idpEntityId: 'https://idp.example.test',
      idpSsoUrl: 'https://idp.example.test/sso',
      idpCert: 'x'.repeat(200),
    });
    expect(saml.statusCode).toBe(403);
    expect(saml.json().error.message).toContain('disabled');
    const start = await api(null, 'POST', `/api/auth/saml:${ws}/start`, {
      state: 's'.repeat(22),
      codeChallenge: 'c'.repeat(43),
      redirectUri: 'http://localhost:3000/api/auth/callback/saml',
    });
    expect(start.statusCode).toBe(404);

    expect((await api(root, 'DELETE', '/api/admin/settings/auth')).statusCode).toBe(204);
    expect(await providers()).toContain('email');
  });

  it('stores GitHub credentials sealed; secrets are write-only (INST-15/16)', async () => {
    await put('auth', {
      github: { enabled: true, clientId: 'gh-id', clientSecret: 'gh-secret-1' },
    });
    expect(await providers()).toContain('github');
    const view = (await api(root, 'GET', '/api/admin/settings')).json().auth;
    expect(view.source).toBe('database');
    expect(view.value.github.clientSecret).not.toContain('gh-secret-1');
    const row = await app.container.systemDb.instanceConfig.findUnique({
      where: { key: 'settings.auth' },
    });
    expect(JSON.stringify(row?.value)).not.toContain('gh-secret-1');

    // Omitted secret: the stored one stays.
    await put('auth', { github: { enabled: true, clientId: 'gh-id-2' } });
    expect(await providers()).toContain('github');
    await put('auth', { github: { enabled: false } });
    expect(await providers()).not.toContain('github');

    const events = (await api(root, 'GET', '/api/admin/audit')).json().events as {
      action: string;
      metadata: { key: string; fields?: string[] };
    }[];
    const updates = events.filter((e) => e.action === 'instance.config_updated');
    expect(updates[0].metadata).toMatchObject({ key: 'auth', fields: ['github'] });
    expect(JSON.stringify(updates)).not.toContain('gh-secret-1');
    expect(JSON.stringify(updates)).not.toContain('gh-id');
    await api(root, 'DELETE', '/api/admin/settings/auth');
  });

  it('switches the default storage at runtime, after testing it (INST-11)', async () => {
    const broken = await put('storage', {
      adapter: 's3',
      bucket: 'harmoniq-test',
      region: 'us-east-1',
      endpoint: 'http://127.0.0.1:9',
      accessKeyId: 'AKIA',
      secretAccessKey: 'nope',
    });
    expect(broken.statusCode).toBe(400);
    expect(broken.json().error.message).toContain('storage test failed');
    expect(app.container.settings.source('storage')).toBe('environment');

    expect((await put('storage', { adapter: 'none' })).statusCode).toBe(200);
    expect(app.container.instanceStorage).toBeNull();
    const health = (await api(root, 'GET', '/api/admin/health')).json();
    expect(health.checks.storage.adapter).toBe('none');

    expect((await put('storage', { adapter: 'local' })).statusCode).toBe(200);
    const test = (await api(root, 'POST', '/api/admin/settings/storage/test')).json();
    expect(test).toMatchObject({ adapter: 'local', ok: true });
    await api(root, 'DELETE', '/api/admin/settings/storage');
    expect(app.container.settings.source('storage')).toBe('environment');
  }, 30_000);

  it('sends mail through the configured SMTP; Send Test Email reports failures (INST-12)', async () => {
    await put('email', { host: '127.0.0.1', port: 9, security: 'none', from: 'Ops <ops@x.test>' });
    expect(app.container.mailer).not.toBeInstanceOf(ConsoleMailer);
    const failed = await api(root, 'POST', '/api/admin/settings/email/test');
    expect(failed.statusCode).toBe(400);
    expect(failed.json().error.message).toContain('Sending failed');

    await api(root, 'DELETE', '/api/admin/settings/email');
    const mailer = app.container.mailer as ConsoleMailer;
    expect(mailer).toBeInstanceOf(ConsoleMailer);
    const ok = await api(root, 'POST', '/api/admin/settings/email/test');
    expect(ok.json()).toEqual({ sentTo: rootEmail });
    expect(mailer.sent.at(-1)).toMatchObject({ to: rootEmail });
  });

  it('brands the dashboard and emails (INST-14)', async () => {
    expect((await put('branding', { name: 'Acme', accentColor: 'red' })).statusCode).toBe(400);
    await put('branding', {
      name: 'Acme Deploy',
      accentColor: '#4f46e5',
      supportUrl: 'https://help.acme.test',
    });
    expect((await api(null, 'GET', '/api/instance')).json().branding).toMatchObject({
      name: 'Acme Deploy',
      accentColor: '#4f46e5',
    });
    const email = `brand-${Date.now()}@test.local`;
    await api(null, 'POST', '/api/auth/email/request', {
      email,
      redirectUri: 'http://localhost:3000/auth/verify',
      nonce: 'n'.repeat(16),
    });
    const sent = (app.container.mailer as ConsoleMailer).sent.find((m) => m.to === email);
    expect(sent?.subject).toContain('Acme Deploy');
    await app.container.systemDb.emailLoginToken.deleteMany({ where: { email } });
  });

  it('picks up changes made by another replica on reload (INST-17)', async () => {
    await app.container.systemDb.instanceConfig.upsert({
      where: { key: 'settings.branding' },
      create: { key: 'settings.branding', value: { name: 'From elsewhere' }, updatedBy: 'test' },
      update: { value: { name: 'From elsewhere' } },
    });
    // The 60-second timer calls this.
    await app.container.settings.reload();
    expect(app.container.settings.branding().name).toBe('From elsewhere');
  });
});
