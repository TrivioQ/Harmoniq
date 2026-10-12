// Copyright The Harmoniq Authors
// SPDX-License-Identifier: Apache-2.0

import type { FastifyReply } from 'fastify';
import type { Prisma } from '@prisma/client';
import { BadRequestError } from '@harmoniq/core/dist/errors/AppError';
import type { PlanLimits } from '@harmoniq/core/dist/schemas/AdminSchemas';
import type { Plans } from './plans';
import type { Quotas } from './quotas';
import { usageDay } from './usage';

type Tx = Prisma.TransactionClient;

/** How many days of history a report covers (`?days=`, default 30). */
export function reportDays(raw: string | undefined) {
  if (raw === undefined) return 30;
  const days = Number(raw);
  if (!Number.isInteger(days) || days < 1 || days > 400) {
    throw new BadRequestError('days must be a whole number from 1 to 400');
  }
  return days;
}

export interface DailyUsage {
  day: string;
  manifestRequests: number;
  deploys: number;
  healthEvents: number;
  storageBytes: number;
  members: number;
  apiKeys: number;
}

export interface WorkspaceUsage {
  slug: string;
  name: string;
  plan: string;
  /** Against `limits` (storage in bytes; `environmentsPerHostApp`: the fullest host app). */
  current: {
    members: number;
    modules: number;
    environmentsPerHostApp: number;
    storageBytes: number;
    deploysPerMonth: number;
    webhooks: number;
  };
  limits: PlanLimits;
  daily: DailyUsage[];
}

/**
 * USG-03: usage against quotas for workspaces the caller may see (`tx` is their tenant
 * scope; `workspaces` were listed in it), with `days` of daily history.
 */
export async function workspaceUsage(
  deps: { plans: Plans; quotas: Quotas },
  tx: Tx,
  workspaces: Array<{ id: string; slug: string; name: string }>,
  days: number
): Promise<WorkspaceUsage[]> {
  if (!workspaces.length) return [];
  const ids = workspaces.map((w) => w.id);
  const since = new Date(Date.now() - (days - 1) * 86_400_000);
  const [rows, envCounts] = await Promise.all([
    tx.usageDaily.findMany({
      where: { workspaceId: { in: ids }, day: { gte: new Date(usageDay(since)) } },
      orderBy: { day: 'asc' },
    }),
    tx.environment.groupBy({
      by: ['hostAppId'],
      where: { hostApp: { workspaceId: { in: ids } }, ephemeral: false },
      _count: true,
    }),
  ]);
  const hostApps = await tx.hostApp.findMany({
    where: { workspaceId: { in: ids } },
    select: { id: true, workspaceId: true },
  });
  const fullest = new Map<string, number>();
  for (const g of envCounts) {
    const ws = hostApps.find((h) => h.id === g.hostAppId)?.workspaceId;
    if (ws) fullest.set(ws, Math.max(fullest.get(ws) ?? 0, g._count));
  }
  return Promise.all(
    workspaces.map(async (w) => {
      const target = { workspaceId: w.id };
      const [entitlements, members, modules, storageBytes, deploysPerMonth, webhooks] =
        await Promise.all([
          deps.plans.forWorkspace({ id: w.id }),
          deps.quotas.used(target, 'members'),
          deps.quotas.used(target, 'modules'),
          deps.quotas.used(target, 'storageGb'),
          deps.quotas.used(target, 'deploysPerMonth'),
          deps.quotas.used(target, 'webhooks'),
        ]);
      return {
        slug: w.slug,
        name: w.name,
        plan: entitlements.plan,
        current: {
          members,
          modules,
          environmentsPerHostApp: fullest.get(w.id) ?? 0,
          storageBytes,
          deploysPerMonth,
          webhooks,
        },
        limits: entitlements.limits,
        daily: rows
          .filter((r) => r.workspaceId === w.id)
          .map((r) => ({
            day: r.day.toISOString().slice(0, 10),
            manifestRequests: Number(r.manifestRequests),
            deploys: r.deploys,
            healthEvents: r.healthEvents,
            storageBytes: Number(r.storageBytes),
            members: r.members,
            apiKeys: r.apiKeys,
          })),
      };
    })
  );
}

/** Sums of the current usage and of the period's counters. */
export function usageTotals(usage: WorkspaceUsage[]) {
  const sum = (pick: (u: WorkspaceUsage) => number) => usage.reduce((n, u) => n + pick(u), 0);
  const period = (field: 'manifestRequests' | 'deploys' | 'healthEvents') =>
    sum((u) => u.daily.reduce((n, d) => n + d[field], 0));
  return {
    workspaces: usage.length,
    members: sum((u) => u.current.members),
    modules: sum((u) => u.current.modules),
    storageBytes: sum((u) => u.current.storageBytes),
    deploysPerMonth: sum((u) => u.current.deploysPerMonth),
    webhooks: sum((u) => u.current.webhooks),
    period: {
      manifestRequests: period('manifestRequests'),
      deploys: period('deploys'),
      healthEvents: period('healthEvents'),
    },
  };
}

const CSV_COLUMNS = [
  'workspace',
  'day',
  'manifestRequests',
  'deploys',
  'healthEvents',
  'storageBytes',
  'members',
  'apiKeys',
] as const;

/** USG-03: one row per workspace and day, as a download. */
export function sendUsageCsv(reply: FastifyReply, name: string, usage: WorkspaceUsage[]) {
  const lines = [CSV_COLUMNS.join(',')];
  for (const u of usage) {
    for (const d of u.daily) {
      // Slugs are [a-z0-9-] and the rest are numbers: nothing to quote.
      lines.push(
        [
          u.slug,
          d.day,
          d.manifestRequests,
          d.deploys,
          d.healthEvents,
          d.storageBytes,
          d.members,
          d.apiKeys,
        ].join(',')
      );
    }
  }
  return reply
    .header('Content-Type', 'text/csv; charset=utf-8')
    .header(
      'Content-Disposition',
      `attachment; filename="harmoniq-usage-${name}-${usageDay()}.csv"`
    )
    .header('Cache-Control', 'no-store')
    .send(lines.join('\n') + '\n');
}
