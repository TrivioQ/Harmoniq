// Copyright The Harmoniq Authors
// SPDX-License-Identifier: Apache-2.0

import { Prisma, type PrismaClient } from '@prisma/client';
import type { ILogger } from '@harmoniq/core/dist/ports/ILogger';

/** USG-01: daily rows are kept this long (13 months). */
export const USAGE_RETENTION_DAYS = 395;
const FLUSH_MS = 60_000;
// Slugs come from URLs; only served responses are counted, but stay bounded regardless.
const MAX_KEYS = 50_000;

type Counters = { manifestRequests: number; deploys: number; healthEvents: number };
const empty = (): Counters => ({ manifestRequests: 0, deploys: 0, healthEvents: 0 });

/** The UTC day, as the `date` column stores it. */
export const usageDay = (now = new Date()) => now.toISOString().slice(0, 10);

/**
 * USG-01 (ADR-012): request counters kept per replica and added to the day's row every
 * minute with `INSERT … ON CONFLICT DO UPDATE SET x = x + excluded.x`, so replicas never
 * overwrite each other. Manifests and health reports are counted by workspace slug (cache
 * hits never resolve the workspace); slugs are resolved at flush, unknown ones dropped.
 */
export class UsageMeter {
  private bySlug = new Map<string, Counters>();
  private byId = new Map<string, Counters>();
  private timer: NodeJS.Timeout | null = null;
  private flushing: Promise<void> | null = null;

  constructor(private deps: { systemDb: PrismaClient; logger: ILogger }) {}

  private bump(map: Map<string, Counters>, key: string, field: keyof Counters, n: number) {
    let entry = map.get(key);
    if (!entry) {
      if (map.size >= MAX_KEYS) return;
      entry = empty();
      map.set(key, entry);
    }
    entry[field] += n;
  }

  /** A served manifest (including 304s and cache hits). */
  manifestServed(workspaceSlug: string) {
    this.bump(this.bySlug, workspaceSlug, 'manifestRequests', 1);
  }

  healthEvents(workspaceSlug: string, count: number) {
    if (count > 0) this.bump(this.bySlug, workspaceSlug, 'healthEvents', count);
  }

  deployed(workspaceId: string) {
    this.bump(this.byId, workspaceId, 'deploys', 1);
  }

  start() {
    this.timer ??= setInterval(() => void this.flush(), FLUSH_MS);
    this.timer.unref();
  }

  async stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.flush();
  }

  /** Writes and resets the counters; on failure they are kept for the next flush. */
  flush(): Promise<void> {
    this.flushing ??= this.write().finally(() => {
      this.flushing = null;
    });
    return this.flushing;
  }

  private async write() {
    const bySlug = this.bySlug;
    const byId = this.byId;
    this.bySlug = new Map();
    this.byId = new Map();
    if (!bySlug.size && !byId.size) return;
    const totals = new Map<string, Counters>(byId);
    try {
      if (bySlug.size) {
        const rows = await this.deps.systemDb.workspace.findMany({
          where: { slug: { in: [...bySlug.keys()] } },
          select: { id: true, slug: true },
        });
        for (const { id, slug } of rows) {
          const add = bySlug.get(slug)!;
          const sum = totals.get(id) ?? empty();
          sum.manifestRequests += add.manifestRequests;
          sum.healthEvents += add.healthEvents;
          totals.set(id, sum);
        }
      }
      if (!totals.size) return;
      const day = usageDay();
      const values = [...totals].map(
        ([id, c]) =>
          Prisma.sql`(${id}, ${day}::date, ${BigInt(c.manifestRequests)}, ${c.deploys}, ${c.healthEvents})`
      );
      await this.deps.systemDb.$executeRaw`
        INSERT INTO "UsageDaily" ("workspaceId", "day", "manifestRequests", "deploys", "healthEvents")
        VALUES ${Prisma.join(values)}
        ON CONFLICT ("workspaceId", "day") DO UPDATE SET
          "manifestRequests" = "UsageDaily"."manifestRequests" + excluded."manifestRequests",
          "deploys" = "UsageDaily"."deploys" + excluded."deploys",
          "healthEvents" = "UsageDaily"."healthEvents" + excluded."healthEvents"`;
    } catch (err) {
      this.deps.logger.warn(`Usage flush failed, kept for the next one: ${(err as Error).message}`);
      for (const [slug, c] of bySlug) {
        this.bump(this.bySlug, slug, 'manifestRequests', c.manifestRequests);
        this.bump(this.bySlug, slug, 'healthEvents', c.healthEvents);
      }
      for (const [id, c] of byId) this.bump(this.byId, id, 'deploys', c.deploys);
    }
  }

  /**
   * USG-01/02: the day's levels for every live workspace: bundle bytes of kept versions,
   * joined members and active API keys. Also drops rows past retention.
   */
  async snapshot(now = new Date()) {
    const day = usageDay(now);
    const written = await this.deps.systemDb.$executeRaw`
      INSERT INTO "UsageDaily" ("workspaceId", "day", "storageBytes", "members", "apiKeys")
      SELECT w."id", ${day}::date,
        COALESCE((SELECT SUM(v."sizeBytes") FROM "ModuleVersion" v
                  WHERE v."workspaceId" = w."id" AND v."deletedAt" IS NULL), 0),
        (SELECT COUNT(*) FROM "WorkspaceMember" m
          WHERE m."workspaceId" = w."id" AND m."joinedAt" IS NOT NULL),
        (SELECT COUNT(*) FROM "ApiKey" k
          WHERE k."workspaceId" = w."id" AND k."revokedAt" IS NULL
            AND (k."expiresAt" IS NULL OR k."expiresAt" > now()))
      FROM "Workspace" w
      WHERE w."deletedAt" IS NULL
      ON CONFLICT ("workspaceId", "day") DO UPDATE SET
        "storageBytes" = excluded."storageBytes",
        "members" = excluded."members",
        "apiKeys" = excluded."apiKeys"`;
    const dropped = await this.deps.systemDb.$executeRaw`
      DELETE FROM "UsageDaily"
      WHERE "day" < (${day}::date - ${USAGE_RETENTION_DAYS}::int)`;
    this.deps.logger.info(`usage.snapshot: ${written} workspaces, ${dropped} old rows dropped`);
    return { written, dropped };
  }
}
