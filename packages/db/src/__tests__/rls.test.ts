// Copyright The Harmoniq Authors
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'crypto';
import { createDbClients, withTenant, DbClients, Workspace } from '../index';

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
