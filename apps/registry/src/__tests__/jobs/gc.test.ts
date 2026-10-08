import { describe, it, expect, beforeEach, afterEach, afterAll } from 'vitest';
import { randomUUID } from 'crypto';
import { createDbClients } from '@harmoniq/db';
import { handleSoftDelete, handleHardDelete, handleHealthEventPurge } from '../../jobs/gc';
import { ConsoleLogger } from '../../adapters/ConsoleLogger';

const { db, systemDb } = createDbClients();
const logger = new ConsoleLogger();
const daysAgo = (n: number) => new Date(Date.now() - n * 24 * 60 * 60 * 1000);

describe('GC jobs', () => {
  let workspaceId: string;
  let moduleId: string;
  let environmentId: string;

  beforeEach(async () => {
    const ws = await systemDb.workspace.create({
      data: { slug: `gc-${randomUUID().slice(0, 8)}`, name: 'GC', retentionDays: 30 },
    });
    workspaceId = ws.id;
    const host = await systemDb.hostApp.create({
      data: {
        workspaceId,
        name: 'Host',
        slug: 'host',
        Environments: { create: [{ name: 'Production', slug: 'production' }] },
      },
      include: { Environments: true },
    });
    environmentId = host.Environments[0].id;
    moduleId = (
      await systemDb.remoteModule.create({
        data: { workspaceId, hostAppId: host.id, name: 'checkout', slug: 'checkout' },
      })
    ).id;
  });

  afterEach(async () => {
    await systemDb.workspace.delete({ where: { id: workspaceId } });
  });

  afterAll(async () => {
    await Promise.all([db.$disconnect(), systemDb.$disconnect()]);
  });

  const version = (n: number, status: 'active' | 'inactive' | 'canary', deployedAt: Date) =>
    systemDb.moduleVersion.create({
      data: {
        workspaceId,
        remoteModuleId: moduleId,
        environmentId,
        version: `1.0.${n}`,
        url: `https://cdn.example.com/${n}.js`,
        integrity: 'sha384-x',
        status,
        deployedBy: 'test',
        deployedByType: 'user',
        deployedAt,
      },
    });

  it('keeps the newest versions for rollback even when they are past retention', async () => {
    // A module untouched for months: everything is older than the 30-day retention.
    await version(0, 'active', daysAgo(200));
    for (let n = 1; n <= 14; n++) await version(n, 'inactive', daysAgo(200 - n));

    await handleSoftDelete(systemDb, logger, { keepVersions: 10 });

    const remaining = await systemDb.moduleVersion.findMany({
      where: { remoteModuleId: moduleId, deletedAt: null },
      orderBy: { deployedAt: 'desc' },
    });
    expect(remaining).toHaveLength(11); // newest 10 + the (oldest) active version
    expect(remaining.map((v) => v.version)).toContain('1.0.0');
    expect(remaining.slice(0, 10).map((v) => v.version)).toEqual(
      Array.from({ length: 10 }, (_, i) => `1.0.${14 - i}`)
    );
  });

  it('respects the workspace retention window', async () => {
    for (let n = 1; n <= 12; n++) await version(n, 'inactive', daysAgo(20));
    await handleSoftDelete(systemDb, logger, { keepVersions: 2 });

    const deleted = await systemDb.moduleVersion.count({
      where: { remoteModuleId: moduleId, deletedAt: { not: null } },
    });
    expect(deleted).toBe(0); // 20 days old < 30-day retention
  });

  it('never deletes canary versions', async () => {
    for (let n = 1; n <= 3; n++) await version(n, 'canary', daysAgo(400));
    await handleSoftDelete(systemDb, logger, { keepVersions: 1 });
    expect(
      await systemDb.moduleVersion.count({ where: { remoteModuleId: moduleId, deletedAt: null } })
    ).toBe(3);
  });

  it('hard-deletes after purging bundles, and retries when purging fails', async () => {
    const v = await version(1, 'inactive', daysAgo(400));
    await systemDb.moduleVersion.update({
      where: { id: v.id },
      data: { deletedAt: daysAgo(8), storagePath: 'modules/x/1.js' },
    });

    const failing = async () => {
      throw new Error('bucket unreachable');
    };
    await handleHardDelete(systemDb, logger, failing);
    expect(await systemDb.moduleVersion.findUnique({ where: { id: v.id } })).not.toBeNull();

    const purged: string[] = [];
    await handleHardDelete(systemDb, logger, async (_ws, paths) => {
      purged.push(...paths);
    });
    expect(purged).toEqual(['modules/x/1.js']);
    expect(await systemDb.moduleVersion.findUnique({ where: { id: v.id } })).toBeNull();
  });

  it('purges old health events', async () => {
    await expect(handleHealthEventPurge(systemDb, logger)).resolves.toBeUndefined();
  });
});
