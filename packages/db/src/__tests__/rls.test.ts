// Copyright The Harmoniq Authors
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'crypto';
import { createDbClients, withOrg, withTenant, DbClients, Workspace } from '../index';

describe('Row-Level Security', () => {
  let clients: DbClients;
  let ws1: Workspace;
  let ws2: Workspace;
  const run = randomUUID().slice(0, 8);

  beforeAll(async () => {
    clients = createDbClients();
    const { db, systemDb } = clients;

    // Workspaces are created by the system role, like tenant resolution in the registry.
    ws1 = await systemDb.workspace.create({ data: { slug: `rls-a-${run}`, name: 'RLS A' } });
    ws2 = await systemDb.workspace.create({ data: { slug: `rls-b-${run}`, name: 'RLS B' } });

    await withTenant(db, ws1.id, (tx) =>
      tx.hostApp.create({
        data: {
          workspaceId: ws1.id,
          name: 'App A',
          slug: 'app-a',
          Environments: { create: [{ name: 'Production', slug: 'production' }] },
        },
      })
    );
    await withTenant(db, ws2.id, (tx) =>
      tx.hostApp.create({
        data: {
          workspaceId: ws2.id,
          name: 'App B',
          slug: 'app-b',
          Environments: { create: [{ name: 'Production', slug: 'production' }] },
        },
      })
    );
  });

  afterAll(async () => {
    await clients.systemDb.workspace.deleteMany({ where: { id: { in: [ws1.id, ws2.id] } } });
    await Promise.all([clients.db.$disconnect(), clients.systemDb.$disconnect()]);
  });

  it('protects every table that has a workspaceId', async () => {
    const unprotected = await clients.systemDb.$queryRaw<Array<{ table: string }>>`
      SELECT c.relname AS table
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = 'public'
       WHERE c.relkind = 'r'
         AND EXISTS (SELECT 1 FROM information_schema.columns col
                      WHERE col.table_schema = 'public' AND col.table_name = c.relname
                        AND col.column_name = 'workspaceId')
         AND (NOT c.relrowsecurity
              OR NOT EXISTS (SELECT 1 FROM pg_policies p
                              WHERE p.schemaname = 'public' AND p.tablename = c.relname))`;
    expect(unprotected.map((r) => r.table)).toEqual([]);
  });

  it('scopes reads to the current workspace', async () => {
    const apps1 = await withTenant(clients.db, ws1.id, (tx) => tx.hostApp.findMany());
    expect(apps1.map((a) => a.name)).toEqual(['App A']);

    const apps2 = await withTenant(clients.db, ws2.id, (tx) => tx.hostApp.findMany());
    expect(apps2.map((a) => a.name)).toEqual(['App B']);
  });

  it('scopes tables without a workspaceId through their parent', async () => {
    const envs = await withTenant(clients.db, ws1.id, (tx) =>
      tx.environment.findMany({ include: { hostApp: true } })
    );
    expect(envs).toHaveLength(1);
    expect(envs[0].hostApp.name).toBe('App A');
  });

  it('returns nothing for the tenant role without a workspace context', async () => {
    expect(await clients.db.hostApp.findMany()).toEqual([]);
    expect(await clients.db.workspace.findMany()).toEqual([]);
  });

  it('rejects writes into another workspace', async () => {
    await expect(
      withTenant(clients.db, ws1.id, (tx) =>
        tx.hostApp.create({ data: { workspaceId: ws2.id, name: 'Sneaky', slug: 'sneaky' } })
      )
    ).rejects.toThrow();
  });

  it('does not leak the workspace context to later queries on the pool', async () => {
    await withTenant(clients.db, ws1.id, (tx) => tx.hostApp.findMany());
    expect(await clients.db.hostApp.findMany()).toEqual([]);
  });

  it('keeps the audit log append-only for the tenant role', async () => {
    const event = await withTenant(clients.db, ws1.id, (tx) =>
      tx.auditEvent.create({
        data: {
          workspaceId: ws1.id,
          actorId: 'test',
          actorType: 'user',
          action: 'test.append_only',
          resourceType: 'workspace',
          resourceId: ws1.id,
        },
      })
    );

    await expect(
      withTenant(clients.db, ws1.id, (tx) =>
        tx.auditEvent.update({ where: { id: event.id }, data: { action: 'tampered' } })
      )
    ).rejects.toThrow();
    await expect(
      withTenant(clients.db, ws1.id, (tx) => tx.auditEvent.delete({ where: { id: event.id } }))
    ).rejects.toThrow();
  });

  it('lets the system role see every workspace', async () => {
    const found = await clients.systemDb.hostApp.findMany({
      where: { workspaceId: { in: [ws1.id, ws2.id] } },
    });
    expect(found).toHaveLength(2);
  });
});

// MT-07/08 (ADR-010): an organization transaction sees its own rows and its workspaces'.
describe('Organization-scoped Row-Level Security', () => {
  let clients: DbClients;
  const run = randomUUID().slice(0, 8);
  const ids = { orgA: '', orgB: '', a1: '', a2: '', b: '', solo: '', user: '' };

  beforeAll(async () => {
    clients = createDbClients();
    const { systemDb } = clients;
    const orgA = await systemDb.organization.create({ data: { slug: `orls-a-${run}`, name: 'A' } });
    const orgB = await systemDb.organization.create({ data: { slug: `orls-b-${run}`, name: 'B' } });
    const ws = (slug: string, organizationId?: string) =>
      systemDb.workspace.create({
        data: {
          slug: `orls-${slug}-${run}`,
          name: slug,
          organizationId,
          HostApps: { create: { name: slug, slug: 'app' } },
        },
      });
    const [a1, a2, b, solo] = await Promise.all([
      ws('a1', orgA.id),
      ws('a2', orgA.id),
      ws('b', orgB.id),
      ws('solo'),
    ]);
    const user = await systemDb.user.create({ data: { email: `orls-${run}@test.local` } });
    Object.assign(ids, {
      orgA: orgA.id,
      orgB: orgB.id,
      a1: a1.id,
      a2: a2.id,
      b: b.id,
      solo: solo.id,
      user: user.id,
    });
    for (const org of [orgA, orgB]) {
      await systemDb.organizationMember.create({
        data: { organizationId: org.id, userId: user.id, role: 'org_member' },
      });
      await systemDb.scimUser.create({
        data: { organizationId: org.id, userId: user.id, userName: `u-${org.slug}` },
      });
    }
  });

  afterAll(async () => {
    const { systemDb } = clients;
    await systemDb.workspace.deleteMany({
      where: { id: { in: [ids.a1, ids.a2, ids.b, ids.solo] } },
    });
    await systemDb.organization.deleteMany({ where: { id: { in: [ids.orgA, ids.orgB] } } });
    await systemDb.user.deleteMany({ where: { id: ids.user } });
    await Promise.all([clients.db.$disconnect(), clients.systemDb.$disconnect()]);
  });

  it('protects every table that has an organizationId', async () => {
    const unprotected = await clients.systemDb.$queryRaw<Array<{ table: string }>>`
      SELECT c.relname AS table
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = 'public'
       WHERE c.relkind = 'r'
         AND EXISTS (SELECT 1 FROM information_schema.columns col
                      WHERE col.table_schema = 'public' AND col.table_name = c.relname
                        AND col.column_name = 'organizationId')
         AND c.relname <> 'Workspace'
         AND (NOT c.relrowsecurity
              OR NOT EXISTS (SELECT 1 FROM pg_policies p
                              WHERE p.schemaname = 'public' AND p.tablename = c.relname
                                AND p.qual LIKE '%app.current_org_id%'))`;
    expect(unprotected.map((r) => r.table)).toEqual([]);
  });

  it("sees the organization's workspaces and their rows, nothing else", async () => {
    const seen = await withOrg(clients.db, ids.orgA, async (tx) => ({
      workspaces: (await tx.workspace.findMany()).map((w) => w.id).sort(),
      hostApps: (await tx.hostApp.findMany()).map((h) => h.workspaceId).sort(),
      environments: await tx.environment.count(),
    }));
    expect(seen.workspaces).toEqual([ids.a1, ids.a2].sort());
    expect(seen.hostApps).toEqual([ids.a1, ids.a2].sort());
    expect(seen.environments).toBe(0);
  });

  it("sees the organization's own rows only", async () => {
    const seen = await withOrg(clients.db, ids.orgA, async (tx) => ({
      orgs: (await tx.organization.findMany()).map((o) => o.id),
      members: (await tx.organizationMember.findMany()).map((m) => m.organizationId),
      scim: (await tx.scimUser.findMany()).map((u) => u.organizationId),
    }));
    expect(seen).toEqual({ orgs: [ids.orgA], members: [ids.orgA], scim: [ids.orgA] });
  });

  it('rejects writes into another organization or its workspaces', async () => {
    await expect(
      withOrg(clients.db, ids.orgA, (tx) =>
        tx.organizationAuditEvent.create({
          data: {
            organizationId: ids.orgB,
            actorType: 'user',
            actorId: 'x',
            action: 'sneaky',
            resourceType: 'organization',
            resourceId: ids.orgB,
          },
        })
      )
    ).rejects.toThrow();
    await expect(
      withOrg(clients.db, ids.orgA, (tx) =>
        tx.hostApp.create({ data: { workspaceId: ids.b, name: 'x', slug: 'sneaky' } })
      )
    ).rejects.toThrow();
  });

  it('keeps organization rows out of workspace and unscoped queries', async () => {
    expect(await clients.db.organization.findMany()).toEqual([]);
    const inWorkspace = await withTenant(clients.db, ids.a1, async (tx) => ({
      orgs: await tx.organization.count(),
      members: await tx.organizationMember.count(),
      siblings: await tx.workspace.count(),
    }));
    expect(inWorkspace).toEqual({ orgs: 0, members: 0, siblings: 1 });
  });

  it('does not leak the organization context to later queries on the pool', async () => {
    await withOrg(clients.db, ids.orgA, (tx) => tx.workspace.findMany());
    expect(await clients.db.workspace.findMany()).toEqual([]);
    expect(await clients.db.organizationMember.findMany()).toEqual([]);
  });

  it('can detach one of its workspaces (the row leaves the organization)', async () => {
    const extra = await clients.systemDb.workspace.create({
      data: { slug: `orls-x-${run}`, name: 'x', organizationId: ids.orgA },
    });
    try {
      const updated = await withOrg(clients.db, ids.orgA, (tx) =>
        tx.workspace.update({ where: { id: extra.id }, data: { organizationId: null } })
      );
      expect(updated.organizationId).toBeNull();
    } finally {
      await clients.systemDb.workspace.delete({ where: { id: extra.id } });
    }
  });
});
