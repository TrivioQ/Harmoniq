// Copyright The Harmoniq Authors
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { FastifyInstance } from 'fastify';
import { buildApp } from '../app';
import { Fixtures, bearer } from './helpers/fixtures';

// Regression guard for cross-tenant access (product-analysis §3.1, §3.3). Must stay green.
describe('Tenant isolation', () => {
  let app: FastifyInstance;
  let fx: Fixtures;
  let a: Awaited<ReturnType<Fixtures['workspace']>>;
  let b: Awaited<ReturnType<Fixtures['workspace']>>;
  let keyA: string;

  const deployBody = {
    environment: 'production',
    url: 'https://cdn.example.com/checkout/1.0.0/remoteEntry.js',
    version: '1.0.0',
    integrity: 'sha384-abc',
  };

  const deploy = (slug: string, moduleId: string, token: string) =>
    app.inject({
      method: 'POST',
      url: `/api/workspaces/${slug}/modules/${moduleId}/deploy`,
      headers: bearer(token),
      payload: deployBody,
    });

  beforeAll(async () => {
    app = await buildApp();
    await app.ready();
    fx = new Fixtures(app);
    a = await fx.workspace();
    b = await fx.workspace();
    keyA = (await fx.apiKey(a.workspace.id, { scopes: ['deploy:write'] })).raw;
  });

  afterAll(async () => {
    await fx.cleanup();
    await app.close();
  });

  describe('API keys', () => {
    it('deploys within their own workspace', async () => {
      const res = await deploy(a.workspace.slug, a.module.id, keyA);
      expect(res.statusCode).toBe(201);
    });

    it("cannot deploy another workspace's module", async () => {
      const res = await deploy(b.workspace.slug, b.module.id, keyA);
      expect(res.statusCode).toBe(403);
    });

    it('cannot target another workspace slug with their own module id', async () => {
      const res = await deploy(b.workspace.slug, a.module.id, keyA);
      expect(res.statusCode).toBe(403);
    });

    it('cannot request upload URLs for another workspace', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/api/workspaces/${b.workspace.slug}/modules/${b.module.id}/upload-url`,
        headers: bearer(keyA),
        payload: { contentType: 'application/javascript', extension: 'js' },
      });
      expect(res.statusCode).toBe(403);
    });

    it("cannot retry another workspace's dead letters", async () => {
      const adminKeyA = (await fx.apiKey(a.workspace.id, { scopes: ['admin'] })).raw;
      const res = await app.inject({
        method: 'POST',
        url: `/api/workspaces/${b.workspace.slug}/webhooks/dead-letters/anything/retry`,
        headers: bearer(adminKeyA),
      });
      expect(res.statusCode).toBe(403);
    });

    it('is limited to its modules when module-scoped', async () => {
      const other = await fx.module(a.workspace.id, a.hostApp.id, 'search');
      const scoped = (await fx.apiKey(a.workspace.id, { moduleIds: [a.module.id] })).raw;
      expect((await deploy(a.workspace.slug, other.id, scoped)).statusCode).toBe(403);
      expect((await deploy(a.workspace.slug, a.module.id, scoped)).statusCode).toBe(201);
    });

    it('cannot deploy with a read-only scope', async () => {
      const readOnly = (await fx.apiKey(a.workspace.id, { scopes: ['manifest:read'] })).raw;
      expect((await deploy(a.workspace.slug, a.module.id, readOnly)).statusCode).toBe(403);
    });

    it.each([
      ['revoked', { revokedAt: new Date() }],
      ['expired', { expiresAt: new Date(Date.now() - 1000) }],
      ['past its rotation grace period', { gracePeriodEnd: new Date(Date.now() - 1000) }],
    ])('rejects a key that is %s', async (_label, opts) => {
      const key = (await fx.apiKey(a.workspace.id, opts)).raw;
      expect((await deploy(a.workspace.slug, a.module.id, key)).statusCode).toBe(401);
    });

    it('stops a cached key as soon as it is revoked elsewhere (another replica, SCIM)', async () => {
      const key = await fx.apiKey(a.workspace.id, { scopes: ['deploy:write'] });
      // First use verifies the secret and caches it.
      expect((await deploy(a.workspace.slug, a.module.id, key.raw)).statusCode).not.toBe(401);
      // Revoked straight in the database: this process's cache was not told.
      await app.container.systemDb.apiKey.update({
        where: { id: key.record.id },
        data: { revokedAt: new Date() },
      });
      expect((await deploy(a.workspace.slug, a.module.id, key.raw)).statusCode).toBe(401);
    });

    it('rejects a key with the wrong secret', async () => {
      const tampered = keyA.slice(0, -4) + 'XXXX';
      expect((await deploy(a.workspace.slug, a.module.id, tampered)).statusCode).toBe(401);
    });

    it('rejects malformed and missing credentials', async () => {
      expect((await deploy(a.workspace.slug, a.module.id, 'hq_garbage')).statusCode).toBe(401);
      const res = await app.inject({
        method: 'POST',
        url: `/api/workspaces/${a.workspace.slug}/modules/${a.module.id}/deploy`,
        payload: deployBody,
      });
      expect(res.statusCode).toBe(401);
    });
  });

  describe('users', () => {
    const storage = (slug: string, token: string) =>
      app.inject({
        method: 'GET',
        url: `/api/workspaces/${slug}/storage`,
        headers: bearer(token),
      });

    it('get 404 for workspaces they are not a member of', async () => {
      const user = await fx.user();
      await fx.member(a.workspace.id, user.id, 'owner');
      const res = await storage(b.workspace.slug, await fx.session(user));
      expect(res.statusCode).toBe(404);
    });

    it('get 404 while an invitation is not yet accepted', async () => {
      const user = await fx.user();
      await fx.member(b.workspace.id, user.id, 'admin', { joined: false });
      expect((await storage(b.workspace.slug, await fx.session(user))).statusCode).toBe(404);
    });

    it('need a sufficient role', async () => {
      const dev = await fx.user();
      await fx.member(b.workspace.id, dev.id, 'developer');
      expect((await storage(b.workspace.slug, await fx.session(dev))).statusCode).toBe(403);

      const admin = await fx.user();
      await fx.member(b.workspace.id, admin.id, 'admin');
      expect((await storage(b.workspace.slug, await fx.session(admin))).statusCode).toBe(200);
    });

    it('can deploy as developers and are recorded as the deployer', async () => {
      const dev = await fx.user();
      await fx.member(a.workspace.id, dev.id, 'developer');
      const res = await deploy(a.workspace.slug, a.module.id, await fx.session(dev));
      expect(res.statusCode).toBe(201);
      expect(res.json()).toMatchObject({ deployedBy: dev.id, deployedByType: 'user' });
    });

    it('reach any workspace storage only as instance admins', async () => {
      const admin = await fx.user({ instanceAdmin: true });
      expect((await storage(b.workspace.slug, await fx.session(admin))).statusCode).toBe(200);
    });

    it('cannot use an invalid or tampered session token', async () => {
      const user = await fx.user();
      await fx.member(a.workspace.id, user.id, 'owner');
      const token = await fx.session(user);
      const tampered = token.slice(0, -2) + (token.endsWith('A') ? 'BB' : 'AA');
      expect((await storage(a.workspace.slug, tampered)).statusCode).toBe(401);
    });
  });
});
