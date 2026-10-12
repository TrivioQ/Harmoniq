// Copyright The Harmoniq Authors
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'crypto';
import { FastifyInstance } from 'fastify';
import type { IStorage } from '../adapters/storage/IStorage';
import type { StorageTarget } from '../adapters/storage/createStorage';
import { buildApp } from '../app';
import { handleAuditRetention } from '../jobs/gc';
import { deleteWorkspace } from '../services/workspaces';
import { purgeDueTenants } from '../services/tenantLifecycle';
import { Fixtures, bearer } from './helpers/fixtures';

/** A storage target that records deletions (and can be made to fail). */
function recordingTarget(prefix: string, fail = false) {
  const deleted: string[] = [];
  const storage = {
    delete: async (key: string) => {
      if (fail) throw new Error('bucket unreachable');
      deleted.push(key);
    },
  } as unknown as IStorage;
  const target: StorageTarget = { storage, prefix, publicUrl: () => null };
  return { target, deleted };
}

// Gap analysis P0-2/P0-3: deleting a workspace keeps its audit trail and removes its objects.
describe('Workspace deletion (AUD-05, TLC-03)', () => {
  let app: FastifyInstance;
  let fx: Fixtures;
  let root: string;
  const deletedIds: string[] = [];
  const db = () => app.container.systemDb;

  async function seeded() {
    const { workspace, hostApp, module } = await fx.workspace();
    deletedIds.push(workspace.id);
    const env = hostApp.Environments.find((e) => e.slug === 'production')!;
    for (const [i, path] of ['bundles/a.js', 'bundles/b.js'].entries()) {
      await db().moduleVersion.create({
        data: {
          workspaceId: workspace.id,
          remoteModuleId: module.id,
          environmentId: env.id,
          version: `1.0.${i}`,
          url: `https://cdn.example.test/${path}`,
          integrity: 'sha384-x',
          storagePath: path,
          status: i ? 'active' : 'inactive',
          deployedBy: 'test',
          deployedByType: 'user',
        },
      });
    }
    await db().auditEvent.create({
      data: {
        workspaceId: workspace.id,
        actorId: 'test',
        actorType: 'user',
        action: 'module.deploy',
        resourceType: 'module',
        resourceId: module.id,
      },
    });
    return workspace;
  }

  beforeAll(async () => {
    app = await buildApp();
    await app.ready();
    fx = new Fixtures(app);
    root = await fx.session(await fx.user({ instanceAdmin: true }));
  });

  afterAll(async () => {
    await db().auditEvent.deleteMany({ where: { workspaceId: { in: deletedIds } } });
    await fx.cleanup();
    await app.close();
  });

  it("deletes bundles and published copies from the workspace's bucket and the instance storage", async () => {
    const workspace = await seeded();
    const own = recordingTarget('tenant/');
    const instance = recordingTarget('');
    const result = await deleteWorkspace(
      {
        ...app.container,
        publisher: { targetFor: async () => own.target },
        instanceStorage: instance.target,
      },
      workspace
    );
    expect(await db().workspace.findUnique({ where: { id: workspace.id } })).toBeNull();
    for (const deleted of [own.deleted, instance.deleted]) {
      expect(deleted).toEqual(expect.arrayContaining(['bundles/a.js', 'bundles/b.js']));
    }
    expect(own.deleted).toContain(`tenant/manifests/${workspace.slug}/portal/production.json`);
    expect(own.deleted).toContain(`tenant/importmaps/${workspace.slug}/portal/staging.json`);
    expect(instance.deleted).toContain(`manifests/${workspace.slug}/portal/production.json`);
    expect(result).toEqual({
      objectsDeleted: own.deleted.length + instance.deleted.length,
      objectsFailed: 0,
    });
  });

  it('keeps going when the storage fails, and reports it', async () => {
    const workspace = await seeded();
    const broken = recordingTarget('', true);
    const result = await deleteWorkspace(
      {
        ...app.container,
        publisher: { targetFor: async () => broken.target },
        instanceStorage: null,
      },
      workspace
    );
    expect(await db().workspace.findUnique({ where: { id: workspace.id } })).toBeNull();
    expect(result.objectsDeleted).toBe(0);
    expect(result.objectsFailed).toBeGreaterThan(0);
  });

  it('keeps the audit trail, exportable by instance admins (AUD-05)', async () => {
    const workspace = await seeded();
    // Deleted by an instance admin (soft, TLC-02), then purged: the trail stays.
    const res = await app.inject({
      method: 'DELETE',
      url: `/api/admin/workspaces/${workspace.slug}?confirm=${workspace.slug}`,
      headers: bearer(root),
    });
    expect(res.statusCode).toBe(204);
    await db().workspace.update({
      where: { id: workspace.id },
      data: { purgeAfter: new Date(Date.now() - 1000) },
    });
    await purgeDueTenants(app.container);
    expect(await db().workspace.findUnique({ where: { id: workspace.id } })).toBeNull();
    expect(await db().auditEvent.count({ where: { workspaceId: workspace.id } })).toBe(1);
    expect(
      await db().instanceAuditEvent.findFirst({
        where: { action: 'instance.workspace_delete', resourceId: workspace.id },
      })
    ).toMatchObject({ metadata: expect.objectContaining({ purgeAfter: expect.any(String) }) });

    const exported = await app.inject({
      method: 'GET',
      url: `/api/admin/workspace-audit/${workspace.id}/export?format=jsonl`,
      headers: bearer(root),
    });
    expect(exported.statusCode).toBe(200);
    expect(exported.body).toContain('module.deploy');
    const user = await fx.session(await fx.user());
    expect(
      (
        await app.inject({
          method: 'GET',
          url: `/api/admin/workspace-audit/${workspace.id}/export`,
          headers: bearer(user),
        })
      ).statusCode
    ).toBe(403);
  });

  it("purges a deleted workspace's events only past retention", async () => {
    const goneId = `gone-${randomUUID()}`;
    deletedIds.push(goneId);
    const { workspace: live } = await fx.workspace();
    const old = new Date(Date.now() - 500 * 86_400_000);
    const event = (workspaceId: string, createdAt: Date) =>
      db().auditEvent.create({
        data: {
          workspaceId,
          actorId: 'test',
          actorType: 'user',
          action: 'test.retention',
          resourceType: 'workspace',
          resourceId: workspaceId,
          createdAt,
        },
      });
    const [oldGone, recentGone, oldLive] = await Promise.all([
      event(goneId, old),
      event(goneId, new Date()),
      event(live.id, old),
    ]);
    await handleAuditRetention(db(), app.container.logger, 400);
    const left = (
      await db().auditEvent.findMany({
        where: { id: { in: [oldGone.id, recentGone.id, oldLive.id] } },
      })
    ).map((e) => e.id);
    expect(left.sort()).toEqual([recentGone.id, oldLive.id].sort());
  });
});
