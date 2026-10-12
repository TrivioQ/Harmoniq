// Copyright The Harmoniq Authors
// SPDX-License-Identifier: Apache-2.0

import { randomUUID } from 'crypto';
import { readdirSync } from 'fs';
import { hostname } from 'os';
import { dirname, join } from 'path';
import type { PrismaClient } from '@prisma/client';
import type { PgBoss } from 'pg-boss';
import { DOMAINS_RECHECK_QUEUE } from '../jobs/domains';

/**
 * INST-28: what an operator needs to run the instance: the version each replica runs,
 * migrations not applied yet, and the background jobs (schedules, last runs, failures).
 */

const HEARTBEAT_MS = 30_000;
/** A replica not seen for this long is shown as gone; after a day it is forgotten. */
const STALE_MS = 2 * 60_000;
const FORGET_MS = 24 * 3_600_000;

export const REPLICA_ID = randomUUID();
const STARTED_AT = new Date();

export function buildInfo() {
  return {
    version: process.env.HARMONIQ_VERSION ?? process.env.npm_package_version ?? 'dev',
    commit: process.env.HARMONIQ_COMMIT ?? process.env.GIT_COMMIT ?? null,
    node: process.version,
    startedAt: STARTED_AT.toISOString(),
  };
}

/** Writes this replica's heartbeat now and every 30 s; returns a stop function. */
export function startHeartbeat(db: PrismaClient, configLoadedAt: () => Date | null) {
  const { version, commit } = buildInfo();
  const beat = async () => {
    const now = new Date();
    const data = { version, commit, lastSeenAt: now, configLoadedAt: configLoadedAt() };
    await db.replicaHeartbeat.upsert({
      where: { replicaId: REPLICA_ID },
      create: { replicaId: REPLICA_ID, hostname: hostname(), startedAt: STARTED_AT, ...data },
      update: data,
    });
    await db.replicaHeartbeat.deleteMany({
      where: { lastSeenAt: { lt: new Date(now.getTime() - FORGET_MS) } },
    });
  };
  const run = () => beat().catch(() => undefined); // the database may be briefly unreachable
  void run();
  const timer = setInterval(run, HEARTBEAT_MS);
  timer.unref();
  return async () => {
    clearInterval(timer);
    await db.replicaHeartbeat.deleteMany({ where: { replicaId: REPLICA_ID } }).catch(() => {});
  };
}

export async function replicas(db: PrismaClient, now = new Date()) {
  const rows = await db.replicaHeartbeat.findMany({ orderBy: { startedAt: 'asc' } });
  return rows.map((r) => ({
    id: r.replicaId,
    hostname: r.hostname,
    version: r.version,
    commit: r.commit,
    startedAt: r.startedAt.toISOString(),
    lastSeenAt: r.lastSeenAt.toISOString(),
    uptimeSeconds: Math.round((now.getTime() - r.startedAt.getTime()) / 1000),
    configAgeSeconds: r.configLoadedAt
      ? Math.round((now.getTime() - r.configLoadedAt.getTime()) / 1000)
      : null,
    live: now.getTime() - r.lastSeenAt.getTime() < STALE_MS,
    self: r.replicaId === REPLICA_ID,
  }));
}

/** The migrations this build ships with (folder names), or null when they aren't bundled. */
export function bundledMigrations(): string[] | null {
  try {
    const dir = join(dirname(require.resolve('@harmoniq/db/package.json')), 'prisma', 'migrations');
    return readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .sort();
  } catch {
    return null;
  }
}

/** Migrations the build has and the database hasn't applied (or that failed). */
export async function migrationStatus(db: PrismaClient, bundled = bundledMigrations()) {
  const applied = await db.$queryRaw<Array<{ migration_name: string; failed: boolean }>>`
    SELECT migration_name, (finished_at IS NULL AND rolled_back_at IS NULL) AS failed
      FROM "_prisma_migrations" WHERE rolled_back_at IS NULL`;
  const done = new Set(applied.filter((m) => !m.failed).map((m) => m.migration_name));
  return {
    applied: done.size,
    latest: [...done].sort().at(-1) ?? null,
    pending: bundled ? bundled.filter((m) => !done.has(m)) : null,
    failed: applied.filter((m) => m.failed).map((m) => m.migration_name),
  };
}

// ─── Jobs ──────────────────────────────────────────────────────────────────

/** Jobs an admin may start on demand (idempotent maintenance). */
export const MAINTENANCE_QUEUES = [
  'gc.softDelete',
  'gc.hardDelete',
  'gc.healthEventPurge',
  'gc.expireEnvironments',
  'gc.auditRetention',
  'health.rollup',
  'tenant.purge',
  'usage.snapshot',
  'plans.expire',
  'ops.retention',
  DOMAINS_RECHECK_QUEUE,
] as const;

const asDate = (d: Date | null) => (d ? new Date(d).toISOString() : null);

/** pg-boss keeps its jobs in its own schema; absent until a queue has run. */
async function bossInstalled(db: PrismaClient) {
  const rows = await db.$queryRaw<Array<{ ok: boolean }>>`
    SELECT to_regclass('pgboss.job') IS NOT NULL AS ok`;
  return rows[0]?.ok ?? false;
}

/** Each queue's schedule, last run, last success and failure (retained jobs). */
export async function jobQueues(db: PrismaClient) {
  if (!(await bossInstalled(db))) return [];
  const [stats, schedules] = await Promise.all([
    db.$queryRaw<
      Array<{
        name: string;
        last_created: Date | null;
        last_success: Date | null;
        last_failure: Date | null;
        failed: bigint;
        queued: bigint;
        active: bigint;
      }>
    >`
      SELECT name,
             max(created_on) AS last_created,
             max(completed_on) FILTER (WHERE state = 'completed') AS last_success,
             max(completed_on) FILTER (WHERE state = 'failed') AS last_failure,
             count(*) FILTER (WHERE state = 'failed') AS failed,
             count(*) FILTER (WHERE state IN ('created', 'retry')) AS queued,
             count(*) FILTER (WHERE state = 'active') AS active
        FROM pgboss.job
       WHERE name NOT LIKE '\\_\\_pgboss%'
       GROUP BY name`,
    db.$queryRaw<Array<{ name: string; cron: string }>>`
      SELECT name, cron FROM pgboss.schedule`.catch(() => []),
  ]);
  const cron = new Map(schedules.map((s) => [s.name, s.cron]));
  const names = new Set([...stats.map((s) => s.name), ...cron.keys()]);
  const byName = new Map(stats.map((s) => [s.name, s]));
  return [...names].sort().map((name) => {
    const s = byName.get(name);
    return {
      name,
      schedule: cron.get(name) ?? null,
      lastRun: asDate(s?.last_created ?? null),
      lastSuccess: asDate(s?.last_success ?? null),
      lastFailure: asDate(s?.last_failure ?? null),
      failed: Number(s?.failed ?? 0),
      queued: Number(s?.queued ?? 0),
      active: Number(s?.active ?? 0),
      runnable: (MAINTENANCE_QUEUES as readonly string[]).includes(name),
    };
  });
}

/** Failed jobs still retained, newest first (their error from pg-boss's `output`). */
export async function failedJobs(db: PrismaClient, queue?: string, limit = 100) {
  if (!(await bossInstalled(db))) return [];
  const rows = await db.$queryRaw<
    Array<{
      id: string;
      name: string;
      data: unknown;
      output: unknown;
      retry_count: number;
      created_on: Date;
      completed_on: Date | null;
    }>
  >`
    SELECT id::text, name, data, output, retry_count, created_on, completed_on
      FROM pgboss.job
     WHERE state = 'failed' AND (${queue ?? null}::text IS NULL OR name = ${queue ?? null})
     ORDER BY completed_on DESC NULLS LAST
     LIMIT ${limit}`;
  return rows.map((r) => ({
    id: r.id,
    queue: r.name,
    data: r.data,
    error: errorOf(r.output),
    retries: r.retry_count,
    createdAt: r.created_on.toISOString(),
    failedAt: asDate(r.completed_on),
  }));
}

function errorOf(output: unknown): string | null {
  if (!output || typeof output !== 'object') return output == null ? null : String(output);
  const o = output as { message?: string; value?: { message?: string } };
  return o.message ?? o.value?.message ?? JSON.stringify(output).slice(0, 500);
}

/** The queue of a failed job, for pg-boss's `retry(name, id)`. */
export async function queueOfJob(db: PrismaClient, id: string) {
  if (!(await bossInstalled(db))) return null;
  const rows = await db.$queryRaw<Array<{ name: string }>>`
    SELECT name FROM pgboss.job WHERE id::text = ${id} AND state = 'failed'`;
  return rows[0]?.name ?? null;
}

export async function retryJob(boss: PgBoss, db: PrismaClient, id: string) {
  const queue = await queueOfJob(db, id);
  if (!queue) return null;
  await boss.retry(queue, id);
  return { id, queue };
}

/** Starts a maintenance job now (one at a time per queue). */
export async function runNow(boss: PgBoss, queue: string) {
  await boss.createQueue(queue);
  const id = await boss.send(queue, {}, { singletonKey: 'admin-run' });
  return { queue, id };
}

/** INST-38/39: the email log after 30 days, sign-in events after 90. */
export async function purgeOperationalLogs(db: PrismaClient, now = new Date()) {
  const day = 86_400_000;
  const [emails, signIns] = await Promise.all([
    db.emailDelivery.deleteMany({
      where: { createdAt: { lt: new Date(now.getTime() - 30 * day) } },
    }),
    db.signInEvent.deleteMany({ where: { createdAt: { lt: new Date(now.getTime() - 90 * day) } } }),
  ]);
  return { emails: emails.count, signIns: signIns.count };
}
