// Copyright The Harmoniq Authors
// SPDX-License-Identifier: Apache-2.0

/** USG-03: usage against quotas, as the registry reports it. */

export type Quota =
  | 'workspaces'
  | 'members'
  | 'modules'
  | 'environmentsPerHostApp'
  | 'storageGb'
  | 'deploysPerMonth'
  | 'webhooks';

export type PlanLimits = Record<Quota, number | null>;

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

export interface UsageTotals {
  workspaces: number;
  members: number;
  modules: number;
  storageBytes: number;
  deploysPerMonth: number;
  webhooks: number;
  period: { manifestRequests: number; deploys: number; healthEvents: number };
}

/** PLN-05: the dashboard warns from this share of a quota. */
export const WARN_AT = 0.8;
const GB = 1024 ** 3;

/** Each limited quota of a workspace: used, limit and share (storage in GB). */
export function quotaUse(u: WorkspaceUsage) {
  const used: Record<Exclude<Quota, 'workspaces'>, number> = {
    members: u.current.members,
    modules: u.current.modules,
    environmentsPerHostApp: u.current.environmentsPerHostApp,
    storageGb: u.current.storageBytes / GB,
    deploysPerMonth: u.current.deploysPerMonth,
    webhooks: u.current.webhooks,
  };
  return (Object.keys(used) as (keyof typeof used)[]).map((quota) => {
    const limit = u.limits[quota];
    return {
      quota,
      used: used[quota],
      limit,
      share: limit === null ? null : limit === 0 ? 1 : used[quota] / limit,
    };
  });
}

/** Quotas at or past the warning share. */
export const nearLimits = (u: WorkspaceUsage) =>
  quotaUse(u).filter((q) => q.share !== null && q.share >= WARN_AT);

/** Every day of the period ending today (UTC), zero where nothing was recorded. */
export function dailySeries(
  daily: DailyUsage[],
  field: 'manifestRequests' | 'deploys' | 'healthEvents',
  days: number,
  now = new Date()
) {
  const byDay = new Map(daily.map((d) => [d.day, d[field]]));
  return Array.from({ length: days }, (_, i) => {
    const day = new Date(now.getTime() - (days - 1 - i) * 86_400_000).toISOString().slice(0, 10);
    return { day, value: byDay.get(day) ?? 0 };
  });
}
