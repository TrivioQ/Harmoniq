// Copyright The Harmoniq Authors
// SPDX-License-Identifier: Apache-2.0

import { randomUUID } from 'crypto';
import type { AppContainer } from '../plugins/container';
import type { StorageTarget } from '../adapters/storage/createStorage';

export interface Check {
  ok: boolean;
  latencyMs: number;
  error?: string;
}

const PROBE_TIMEOUT_MS = 10_000;

async function timed(fn: () => Promise<void>): Promise<Check> {
  const started = Date.now();
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      fn(),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('Timed out')), PROBE_TIMEOUT_MS);
      }),
    ]);
    return { ok: true, latencyMs: Date.now() - started };
  } catch (err) {
    return { ok: false, latencyMs: Date.now() - started, error: (err as Error).message };
  } finally {
    clearTimeout(timer);
  }
}

/** Write, read back and delete a small object: proves the credentials and the bucket. */
export const probeStorage = (target: StorageTarget) =>
  timed(async () => {
    const key = `${target.prefix}.harmoniq/probe-${randomUUID()}.txt`;
    await target.storage.put(key, 'ok', { contentType: 'text/plain', cacheControl: 'no-store' });
    if (!(await target.storage.exists(key))) {
      throw new Error('The object was written but could not be read back');
    }
    await target.storage.delete(key);
  });

export const probeDatabase = (container: Pick<AppContainer, 'systemDb'>) =>
  timed(async () => {
    await container.systemDb.$queryRaw`SELECT 1`;
  });

export const probeCache = (container: Pick<AppContainer, 'cache'>) =>
  timed(async () => {
    const key = `health:probe:${randomUUID()}`;
    await container.cache.set(key, 'ok', 10);
    if ((await container.cache.get(key)) !== 'ok') throw new Error('Read back a different value');
    await container.cache.del(key);
  });

/**
 * INST-08: database, cache, instance storage and job queue. `status` is `degraded`
 * when any of them fails (an unconfigured storage or queue isn't a failure).
 */
export async function instanceHealth(
  container: AppContainer,
  adapters: { cache: string; storage: string }
) {
  const [database, cache, storage, queue] = await Promise.all([
    probeDatabase(container),
    probeCache(container),
    container.instanceStorage ? probeStorage(container.instanceStorage) : null,
    queueHealth(container),
  ]);
  const ok = database.ok && cache.ok && (storage?.ok ?? true) && queue.ok;
  return {
    status: ok ? ('ok' as const) : ('degraded' as const),
    checks: {
      database,
      cache: { ...cache, adapter: adapters.cache },
      storage: storage
        ? { ...storage, adapter: adapters.storage }
        : { ok: true, latencyMs: 0, adapter: 'none' },
      queue,
    },
  };
}

async function queueHealth(container: AppContainer) {
  const { boss } = container;
  if (!boss) {
    // Tests and setups without SYSTEM_DATABASE_URL run jobs inline.
    return { ok: true, running: false, queued: 0, active: 0, queues: [] };
  }
  try {
    const queues = await boss.getQueues();
    const rows = queues.map((q) => ({
      name: q.name,
      queued: q.queuedCount,
      active: q.activeCount,
    }));
    return {
      ok: true,
      running: true,
      queued: rows.reduce((sum, q) => sum + q.queued, 0),
      active: rows.reduce((sum, q) => sum + q.active, 0),
      queues: rows,
    };
  } catch (err) {
    return {
      ok: false,
      running: true,
      queued: 0,
      active: 0,
      queues: [],
      error: (err as Error).message,
    };
  }
}
