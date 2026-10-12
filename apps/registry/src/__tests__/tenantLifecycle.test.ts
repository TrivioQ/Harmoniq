// Copyright The Harmoniq Authors
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'crypto';
import { FastifyInstance } from 'fastify';
import type { IStorage } from '../adapters/storage/IStorage';
import type { StorageTarget } from '../adapters/storage/createStorage';
import { buildApp } from '../app';
import { publishedPaths } from '../services/manifestPublisher';
import { purgeDueTenants, softDeleteWorkspace } from '../services/tenantLifecycle';
import { Fixtures, bearer } from './helpers/fixtures';

/** In-memory storage target, to see published copies come and go. */
function memoryTarget() {
  const objects = new Map<string, string>();
  const storage = {
    put: async (key: string, body: string) => void objects.set(key, body),
    delete: async (key: string) => void objects.delete(key),
    exists: async (key: string) => objects.has(key),
  } as unknown as IStorage;
  const target: StorageTarget = { storage, prefix: '', publicUrl: () => null };
  return { target, objects };
}

// TLC-01..04 (Phase 9.2): soft delete, restore, purge, organization suspension.
describe('Tenant lifecycle (TLC-01..04)', () => {
  let app: FastifyInstance;
  let fx: Fixtures;
  let owner: string;
  let admin: string;
  let root: string;
  const run = randomUUID().slice(0, 8);
  const extraWorkspaces: string[] = [];

  type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  const api = (as: string | null, method: Method, url: string, payload?: object) =>
    app.inject({ method, url, payload, headers: as ? bearer(as) : {} });
  const db = () => app.container.systemDb;
  const deploy = (as: string, ws: string, version: string) =>
    api(as, 'POST', `/api/workspaces/${ws}/modules/checkout/deploy`, {
      environment: 'production',
      url: `https://cdn.example.com/checkout/${version}.js`,
      version,
      integrity: 'sha384-abc',
    });

  /** A workspace with an owner and an admin member. */
  async function workspace() {
    const { workspace } = await fx.workspace();
    const [o, a] = await Promise.all([fx.user(), fx.user()]);
    await fx.member(workspace.id, o.id, 'owner');
    await fx.member(workspace.id, a.id, 'admin');
    [owner, admin] = await Promise.all([fx.session(o), fx.session(a)]);
    return workspace;
  }

  beforeAll(async () => {
    app = await buildApp();
    await app.ready();
    fx = new Fixtures(app);
    root = await fx.session(await fx.user({ instanceAdmin: true }));
  });

  afterAll(async () => {
    await db().workspace.deleteMany({ where: { id: { in: extraWorkspaces } } });
    await db().organization.deleteMany({ where: { slug: { startsWith: `life-${run}` } } });
    await fx.cleanup();
    await app.close();
  });

  it('lets owners delete a workspace (with the slug typed back), and only owners', async () => {
    const ws = await workspace();
    const W = `/api/workspaces/${ws.slug}`;
    expect((await api(admin, 'DELETE', `${W}?confirm=${ws.slug}`)).statusCode).toBe(403);
    expect((await api(owner, 'DELETE', W)).statusCode).toBe(400);
    expect((await api(owner, 'DELETE', `${W}?confirm=${ws.slug}`)).statusCode).toBe(204);
    const row = await db().workspace.findUniqueOrThrow({ where: { id: ws.id } });
    expect(row.deletedAt).not.toBeNull();
    expect(row.purgeAfter!.getTime()).toBeGreaterThan(Date.now() + 29 * 86_400_000);
    expect(
      await db().auditEvent.findFirst({ where: { workspaceId: ws.id, action: 'workspace.delete' } })
    ).not.toBeNull();
  });

  it('answers 410 to a deleted workspace, its manifests (also cached ones) and its keys', async () => {
    const ws = await workspace();
    const W = `/api/workspaces/${ws.slug}`;
    expect((await deploy(owner, ws.slug, '1.0.0')).statusCode).toBe(201);
    // Cached and last-known-good before the deletion.
    expect((await api(null, 'GET', `/api/manifest/${ws.slug}/portal/production`)).statusCode).toBe(
      200
    );
    const { raw: key } = await fx.apiKey(ws.id, { scopes: ['deploy:write'] });
    await api(owner, 'DELETE', `${W}?confirm=${ws.slug}`);

    const manifest = await api(null, 'GET', `/api/manifest/${ws.slug}/portal/production`);
    expect(manifest.statusCode).toBe(410);
    expect(manifest.json().error.code).toBe('GONE');
    expect((await api(null, 'GET', `/api/manifest/${ws.slug}/production`)).statusCode).toBe(410);
    for (const as of [owner, admin, key]) {
      const res = await api(as, 'GET', W);
      expect(res.statusCode).toBe(410);
      expect(res.json().error.code).toBe('WORKSPACE_DELETED');
    }
    expect((await deploy(key, ws.slug, '1.0.1')).statusCode).toBe(410);
    const me = (await api(owner, 'GET', '/api/me')).json();
    expect(me.workspaces.map((w: { slug: string }) => w.slug)).not.toContain(ws.slug);
  });

  it('restores a deleted workspace: everything comes back', async () => {
    const ws = await workspace();
    const W = `/api/workspaces/${ws.slug}`;
    await deploy(owner, ws.slug, '1.0.0');
    await api(owner, 'DELETE', `${W}?confirm=${ws.slug}`);
    expect((await api(admin, 'POST', `${W}/restore`)).statusCode).toBe(403);
    const restored = await api(owner, 'POST', `${W}/restore`);
    expect(restored.statusCode).toBe(200);
    expect((await api(owner, 'GET', W)).statusCode).toBe(200);
    const manifest = await api(null, 'GET', `/api/manifest/${ws.slug}/portal/production`);
    expect(manifest.statusCode).toBe(200);
    expect(manifest.body).toContain('1.0.0');
    expect((await api(owner, 'POST', `${W}/restore`)).statusCode).toBe(409);
  });

  it('removes published copies at once and keeps bundles until the purge', async () => {
    const ws = await workspace();
    await deploy(owner, ws.slug, '1.0.0');
    const { target, objects } = memoryTarget();
    const paths = publishedPaths(ws.slug, 'portal', 'production');
    objects.set(paths.manifest, '{}');
    objects.set(paths.importMap, '{}');
    objects.set('modules/bundle.js', 'x');
    const deps = {
      ...app.container,
      publisher: {
        targetFor: async () => target,
        publish: (id: string) => app.container.publisher.publish(id),
      },
    };
    await softDeleteWorkspace(deps, ws, { type: 'user', id: 'test' }, 30);
    expect(objects.has(paths.manifest)).toBe(false);
    expect(objects.has(paths.importMap)).toBe(false);
    expect(objects.has('modules/bundle.js')).toBe(true);
  });

  it('purges after the restore window, and at once with a window of 0 days', async () => {
    const ws = await workspace();
    await api(owner, 'DELETE', `/api/workspaces/${ws.slug}?confirm=${ws.slug}`);
    await db().workspace.update({
      where: { id: ws.id },
      data: { purgeAfter: new Date(Date.now() - 1000) },
    });
    const result = await purgeDueTenants(app.container);
    expect(result.workspaces).toBeGreaterThanOrEqual(1);
    expect(await db().workspace.findUnique({ where: { id: ws.id } })).toBeNull();
    expect(
      await db().instanceAuditEvent.findFirst({
        where: { action: 'instance.workspace_purged', resourceId: ws.id },
      })
    ).not.toBeNull();

    const now = await workspace();
    const immediate = await softDeleteWorkspace(
      app.container,
      now,
      { type: 'user', id: 'test' },
      0
    );
    expect(immediate.purgeAfter).toBeNull();
    expect(await db().workspace.findUnique({ where: { id: now.id } })).toBeNull();
  });

  it('lets instance admins delete and restore any workspace', async () => {
    const ws = await workspace();
    const del = await api(root, 'DELETE', `/api/admin/workspaces/${ws.slug}?confirm=${ws.slug}`);
    expect(del.statusCode).toBe(204);
    const list = (await api(root, 'GET', `/api/admin/workspaces?query=${ws.slug}`)).json();
    expect(list.workspaces[0].deletedAt).not.toBeNull();
    expect((await api(owner, 'POST', `/api/admin/workspaces/${ws.slug}/restore`)).statusCode).toBe(
      403
    );
    expect((await api(root, 'POST', `/api/admin/workspaces/${ws.slug}/restore`)).statusCode).toBe(
      200
    );
    expect((await api(owner, 'GET', `/api/workspaces/${ws.slug}`)).statusCode).toBe(200);
  });

  describe('organizations', () => {
    let alice: string; // org admin
    let bob: string; // member of the org's workspace
    const org = `life-${run}`;
    const ws = `life-${run}-shop`;

    beforeAll(async () => {
      const [a, b] = await Promise.all([fx.user(), fx.user()]);
      [alice, bob] = await Promise.all([fx.session(a), fx.session(b)]);
      expect((await api(alice, 'POST', '/api/orgs', { name: org, slug: org })).statusCode).toBe(
        201
      );
      expect(
        (await api(alice, 'POST', `/api/orgs/${org}/workspaces`, { name: ws, slug: ws })).statusCode
      ).toBe(201);
      const w = await db().workspace.findUniqueOrThrow({ where: { slug: ws } });
      extraWorkspaces.push(w.id);
      await fx.member(w.id, b.id, 'developer');
      const hostApp = await db().hostApp.findFirstOrThrow({ where: { workspaceId: w.id } });
      await fx.module(w.id, hostApp.id, 'checkout');
    });

    it('lets org admins delete a workspace and restore it', async () => {
      const del = await api(
        alice,
        'DELETE',
        `/api/orgs/${org}/workspaces/${ws}?delete=true&confirm=${ws}`
      );
      expect(del.statusCode).toBe(204);
      const home = (await api(alice, 'GET', `/api/orgs/${org}`)).json();
      expect(home.workspaces.find((w: { slug: string }) => w.slug === ws).deletedAt).not.toBeNull();
      // Its data leaves the organization's views (catalog) until restored.
      const catalog = (await api(alice, 'GET', `/api/orgs/${org}/modules`)).json();
      expect(catalog.modules).toEqual([]);
      expect((await api(alice, 'POST', `/api/workspaces/${ws}/restore`)).statusCode).toBe(200);
      expect((await api(alice, 'GET', `/api/orgs/${org}/modules`)).json().modules).toHaveLength(1);
    });

    it('refuses changes in a suspended organization; reads still work (TLC-04)', async () => {
      const suspend = await api(root, 'POST', `/api/admin/orgs/${org}/suspend`, {
        reason: 'unpaid invoice',
      });
      expect(suspend.statusCode).toBe(200);
      const write = await deploy(bob, ws, '2.0.0');
      expect(write.statusCode).toBe(403);
      expect(write.json().error.code).toBe('ORGANIZATION_SUSPENDED');
      expect((await api(bob, 'GET', `/api/workspaces/${ws}`)).statusCode).toBe(200);
      expect((await api(alice, 'GET', `/api/orgs/${org}`)).statusCode).toBe(200);
      const rename = await api(alice, 'PATCH', `/api/orgs/${org}`, { name: 'Renamed' });
      expect(rename.statusCode).toBe(403);
      expect(rename.json().error.code).toBe('ORGANIZATION_SUSPENDED');
      expect(
        (await api(root, 'GET', '/api/admin/orgs'))
          .json()
          .organizations.find((o: { slug: string }) => o.slug === org).suspendedReason
      ).toBe('unpaid invoice');

      expect((await api(root, 'POST', `/api/admin/orgs/${org}/unsuspend`)).statusCode).toBe(200);
      expect((await deploy(bob, ws, '2.0.0')).statusCode).toBe(201);
    });

    it('deletes, restores and purges an organization, releasing its slug (TLC-02/03)', async () => {
      // Not while it has (live) workspaces.
      expect((await api(alice, 'DELETE', `/api/orgs/${org}`)).statusCode).toBe(409);
      await api(alice, 'DELETE', `/api/orgs/${org}/workspaces/${ws}?delete=true&confirm=${ws}`);
      expect((await api(alice, 'DELETE', `/api/orgs/${org}`)).statusCode).toBe(204);
      expect((await api(alice, 'GET', `/api/orgs/${org}`)).statusCode).toBe(404);

      expect((await api(root, 'POST', `/api/admin/orgs/${org}/restore`)).statusCode).toBe(200);
      expect((await api(alice, 'GET', `/api/orgs/${org}`)).statusCode).toBe(200);

      await api(alice, 'DELETE', `/api/orgs/${org}`);
      const orgRow = await db().organization.findUniqueOrThrow({ where: { slug: org } });
      // The deleted workspace is purged first; the organization in the same run after it.
      await db().workspace.updateMany({
        where: { slug: ws },
        data: { purgeAfter: new Date(Date.now() - 1000) },
      });
      await db().organization.update({
        where: { id: orgRow.id },
        data: { purgeAfter: new Date(Date.now() - 1000) },
      });
      await purgeDueTenants(app.container);
      expect(await db().organization.findUnique({ where: { slug: org } })).toBeNull();
      // The slug is free again; the audit trail stays (AUD-05).
      expect(
        await db().organizationAuditEvent.count({ where: { organizationId: orgRow.id } })
      ).toBeGreaterThan(0);
      expect((await api(alice, 'POST', '/api/orgs', { name: org, slug: org })).statusCode).toBe(
        201
      );
    });
  });
});
