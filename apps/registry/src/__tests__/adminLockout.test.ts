// Copyright The Harmoniq Authors
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { FastifyInstance } from 'fastify';
import { buildApp } from '../app';
import { Fixtures, bearer } from './helpers/fixtures';

// INST-23: the sign-in settings can't lock the instance, or the admin saving them, out.
describe('Admin lockout guard (INST-23)', () => {
  let app: FastifyInstance;
  let fx: Fixtures;
  let withGithub: { id: string; email: string };
  let withoutGithub: { id: string; email: string };
  let withGithubSession: string;
  let withoutGithubSession: string;

  const putAuth = (session: string, value: object) =>
    app.inject({
      method: 'PUT',
      url: '/api/admin/settings/auth',
      payload: value,
      headers: bearer(session),
    });
  const github = { enabled: true, clientId: 'gh-id', clientSecret: 'gh-secret' };
  const reset = async () => {
    await app.container.systemDb.instanceConfig.deleteMany({ where: { key: 'settings.auth' } });
    await app.container.settings.reload();
  };

  beforeAll(async () => {
    app = await buildApp();
    await app.ready();
    fx = new Fixtures(app);
    await reset();
    withGithub = await fx.user({ instanceAdmin: true });
    withoutGithub = await fx.user({ instanceAdmin: true });
    await app.container.systemDb.identity.create({
      data: {
        userId: withGithub.id,
        provider: 'github',
        providerUserId: `gh-${withGithub.id}`,
        email: withGithub.email,
      },
    });
    [withGithubSession, withoutGithubSession] = await Promise.all([
      fx.session(withGithub),
      fx.session(withoutGithub),
    ]);
  });

  afterEach(reset);

  afterAll(async () => {
    await reset();
    await fx.cleanup();
    await app.close();
  });

  it('refuses turning off the last method any admin can use', async () => {
    // Email works for every account; without it and without GitHub nobody gets in.
    const res = await putAuth(withGithubSession, { email: { enabled: false } });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.message).toContain('No instance admin could sign in');
    expect(app.container.settings.auth().email).toBe(true);
  });

  it('refuses a change that locks out the admin saving it', async () => {
    const res = await putAuth(withoutGithubSession, { email: { enabled: false }, github });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.message).toContain('You could no longer sign in');
  });

  it('allows it when the admin keeps a method, and names the admins it locks out', async () => {
    const res = await putAuth(withGithubSession, { email: { enabled: false }, github });
    expect(res.statusCode).toBe(200);
    expect(res.json().adminsLockedOut).toContain(withoutGithub.email);
    expect(res.json().adminsLockedOut).not.toContain(withGithub.email);

    const [event] = await app.container.systemDb.instanceAuditEvent.findMany({
      where: { action: 'instance.config_updated', actorId: withGithub.id },
      orderBy: { createdAt: 'desc' },
      take: 1,
    });
    // A count only: the audit log never holds emails of other admins.
    expect(event.metadata).toMatchObject({ key: 'auth' });
    expect((event.metadata as { adminsLockedOut: number }).adminsLockedOut).toBeGreaterThan(0);
  });

  it('allows changes that keep everyone in', async () => {
    const res = await putAuth(withoutGithubSession, { saml: { enabled: false } });
    expect(res.statusCode).toBe(200);
    expect(res.json().adminsLockedOut).toBeUndefined();
  });
});
