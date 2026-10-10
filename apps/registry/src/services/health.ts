// Copyright The Harmoniq Authors
// SPDX-License-Identifier: Apache-2.0

import type { PrismaClient } from '@prisma/client';
import type { TenantTx } from '@harmoniq/db';
import type { HealthEvent, HealthStats } from '@harmoniq/core/dist/schemas/HealthReportSchema';

export const HEALTH_WINDOW_MS = 5 * 60_000;
/** Below this many samples per window, a trend is not meaningful. */
const MIN_TREND_SAMPLES = 10;
const LIVE_VERSIONS_TTL_MS = 30_000;

type Variant = 'stable' | 'canary';

/** What may be reported for one environment: its live modules and their versions. */
export interface LiveVersions {
  workspaceId: string;
  environmentId: string;
  modules: Map<string, { moduleId: string; versions: Map<string, Variant> }>;
}

/**
 * Ingest only accepts versions that are live (active or canary) in the environment, so a
 * public endpoint can't fill the table with arbitrary modules. The variant comes from
 * the version, not from the client. Cached briefly per replica: reports arrive in bursts.
 */
export class LiveVersionsCache {
  private entries = new Map<string, { value: LiveVersions | null; expires: number }>();

  constructor(
    private systemDb: PrismaClient,
    private withTenant: <T>(workspaceId: string, fn: (tx: TenantTx) => Promise<T>) => Promise<T>
  ) {}

  /**
   * `maxAgeMs` forces a reload of an older entry, e.g. when a report names a version the
   * cache doesn't know yet (deployed moments ago, possibly on another replica).
   */
  async get(
    ws: string,
    host: string,
    env: string,
    maxAgeMs = LIVE_VERSIONS_TTL_MS
  ): Promise<LiveVersions | null> {
    const key = `${ws}/${host}/${env}`;
    const hit = this.entries.get(key);
    if (hit && hit.expires - LIVE_VERSIONS_TTL_MS + maxAgeMs > Date.now()) return hit.value;

    const value = await this.load(ws, host, env);
    if (this.entries.size > 10_000) this.entries.clear();
    this.entries.set(key, { value, expires: Date.now() + LIVE_VERSIONS_TTL_MS });
    return value;
  }

  private async load(ws: string, host: string, env: string): Promise<LiveVersions | null> {
    const workspace = await this.systemDb.workspace.findUnique({
      where: { slug: ws },
      select: { id: true },
    });
    if (!workspace) return null;
    return this.withTenant(workspace.id, async (tx) => {
      const environment = await tx.environment.findFirst({
        where: { slug: env, hostApp: { slug: host } },
        select: { id: true },
      });
      if (!environment) return null;
      const versions = await tx.moduleVersion.findMany({
        where: {
          environmentId: environment.id,
          status: { in: ['active', 'canary'] },
          deletedAt: null,
        },
        select: { version: true, status: true, remoteModuleId: true, remoteModule: true },
      });
      const modules: LiveVersions['modules'] = new Map();
      for (const v of versions) {
        const entry = modules.get(v.remoteModule.slug) ?? {
          moduleId: v.remoteModuleId,
          versions: new Map(),
        };
        // A version that is both active and canary can't happen; active wins if it did.
        if (!entry.versions.has(v.version) || v.status === 'active') {
          entry.versions.set(v.version, v.status === 'canary' ? 'canary' : 'stable');
        }
        modules.set(v.remoteModule.slug, entry);
      }
      return { workspaceId: workspace.id, environmentId: environment.id, modules };
    });
  }
}

/** Splits a report into rows to store and a count of rejected events. */
export function acceptEvents(live: LiveVersions, events: HealthEvent[], client?: string) {
  const rows = [];
  for (const e of events) {
    const module = live.modules.get(e.module);
    const variant = module?.versions.get(e.version);
    if (!module || !variant) continue;
    rows.push({
      workspaceId: live.workspaceId,
      remoteModuleId: module.moduleId,
      environmentId: live.environmentId,
      variant,
      version: e.version,
      success: e.success,
      loadMs: e.loadMs ?? null,
      errorMessage: e.success ? null : (e.error?.slice(0, 500) ?? null),
      clientVersion: client ?? null,
    });
  }
  return { rows, rejected: events.length - rows.length };
}

type StatsRow = {
  variant: string | null;
  sampleCount: number;
  errorCount: number;
  p50: number | null;
  p95: number | null;
};

const toStats = (row?: StatsRow): HealthStats => {
  const sampleCount = row?.sampleCount ?? 0;
  const errorCount = row?.errorCount ?? 0;
  return {
    sampleCount,
    errorCount,
    loadSuccessRate: sampleCount ? (sampleCount - errorCount) / sampleCount : null,
    p50LoadMs: row?.p50 == null ? null : Math.round(Number(row.p50)),
    p95LoadMs: row?.p95 == null ? null : Math.round(Number(row.p95)),
  };
};

/**
 * HLT-02/03: health per variant and overall in [from, to). Load-time percentiles only
 * count successful loads.
 */
export async function windowStats(
  tx: TenantTx,
  moduleId: string,
  environmentId: string,
  from: Date,
  to: Date
): Promise<{ overall: HealthStats; variants: Record<Variant, HealthStats> }> {
  const rows = await tx.$queryRaw<StatsRow[]>`
    SELECT variant,
           count(*)::int AS "sampleCount",
           (count(*) FILTER (WHERE NOT success))::int AS "errorCount",
           percentile_cont(0.5) WITHIN GROUP (ORDER BY "loadMs")
             FILTER (WHERE success AND "loadMs" IS NOT NULL) AS p50,
           percentile_cont(0.95) WITHIN GROUP (ORDER BY "loadMs")
             FILTER (WHERE success AND "loadMs" IS NOT NULL) AS p95
      FROM "ModuleHealthEvent"
     WHERE "remoteModuleId" = ${moduleId}
       AND "environmentId" = ${environmentId}
       AND "reportedAt" >= ${from} AND "reportedAt" < ${to}
     GROUP BY GROUPING SETS ((variant), ())`;
  const byVariant = (v: string | null) => rows.find((r) => r.variant === v);
  return {
    overall: toStats(byVariant(null)),
    variants: { stable: toStats(byVariant('stable')), canary: toStats(byVariant('canary')) },
  };
}

export type Trend = 'improving' | 'degrading' | 'steady' | 'insufficient_data';

/** Success rate now vs the previous window, with a 1-point dead band. */
export function trendOf(current: HealthStats, previous: HealthStats): Trend {
  if (current.sampleCount < MIN_TREND_SAMPLES || previous.sampleCount < MIN_TREND_SAMPLES) {
    return 'insufficient_data';
  }
  const delta = current.loadSuccessRate! - previous.loadSuccessRate!;
  return delta > 0.01 ? 'improving' : delta < -0.01 ? 'degrading' : 'steady';
}

export function topErrors(
  tx: TenantTx,
  moduleId: string,
  environmentId: string,
  from: Date
): Promise<Array<{ message: string; count: number; variant: string }>> {
  return tx.$queryRaw`
    SELECT coalesce("errorMessage", '(no message)') AS message, variant, count(*)::int AS count
      FROM "ModuleHealthEvent"
     WHERE "remoteModuleId" = ${moduleId} AND "environmentId" = ${environmentId}
       AND "reportedAt" >= ${from} AND NOT success
     GROUP BY 1, 2
     ORDER BY 3 DESC
     LIMIT 5`;
}

export interface HourlyPoint {
  hour: string;
  sampleCount: number;
  errorCount: number;
}

/** HLT-04: hourly totals (all variants) for the last `hours` hours, per module and env. */
export async function hourlySeries(
  tx: TenantTx,
  since: Date,
  filter: { moduleId?: string; environmentId?: string } = {}
): Promise<Array<HourlyPoint & { moduleId: string; environmentId: string }>> {
  const rows = await tx.moduleHealthRollup.groupBy({
    by: ['remoteModuleId', 'environmentId', 'hour'],
    where: {
      hour: { gte: since },
      ...(filter.moduleId && { remoteModuleId: filter.moduleId }),
      ...(filter.environmentId && { environmentId: filter.environmentId }),
    },
    _sum: { sampleCount: true, errorCount: true },
    orderBy: { hour: 'asc' },
  });
  return rows.map((r) => ({
    moduleId: r.remoteModuleId,
    environmentId: r.environmentId,
    hour: r.hour.toISOString(),
    sampleCount: r._sum.sampleCount ?? 0,
    errorCount: r._sum.errorCount ?? 0,
  }));
}

/**
 * Rolls raw events from `since` up into hourly rows (idempotent upsert; the current hour
 * is rewritten as it fills up). Runs as the owner role, across workspaces.
 */
export async function rollUpHealth(db: PrismaClient, since: Date): Promise<number> {
  return db.$executeRaw`
    INSERT INTO "ModuleHealthRollup"
      ("id", "workspaceId", "remoteModuleId", "environmentId", "variant", "hour",
       "sampleCount", "errorCount", "p50LoadMs", "p95LoadMs")
    SELECT gen_random_uuid()::text, "workspaceId", "remoteModuleId", "environmentId", variant,
           date_trunc('hour', "reportedAt"),
           count(*)::int,
           (count(*) FILTER (WHERE NOT success))::int,
           round(percentile_cont(0.5) WITHIN GROUP (ORDER BY "loadMs")
             FILTER (WHERE success AND "loadMs" IS NOT NULL))::int,
           round(percentile_cont(0.95) WITHIN GROUP (ORDER BY "loadMs")
             FILTER (WHERE success AND "loadMs" IS NOT NULL))::int
      FROM "ModuleHealthEvent"
     WHERE "reportedAt" >= date_trunc('hour', ${since}::timestamp)
     GROUP BY "workspaceId", "remoteModuleId", "environmentId", variant,
              date_trunc('hour', "reportedAt")
    ON CONFLICT ("remoteModuleId", "environmentId", "variant", "hour") DO UPDATE SET
      "sampleCount" = EXCLUDED."sampleCount",
      "errorCount" = EXCLUDED."errorCount",
      "p50LoadMs" = EXCLUDED."p50LoadMs",
      "p95LoadMs" = EXCLUDED."p95LoadMs"`;
}
