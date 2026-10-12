// Copyright The Harmoniq Authors
// SPDX-License-Identifier: Apache-2.0

import type { PrismaClient } from '@prisma/client';
import { LRUCache } from 'lru-cache';
import { PlanRequiredError } from '@harmoniq/core/dist/errors/AppError';
import {
  Plan,
  PlanFeature,
  PlanLimits,
  PlanOverrides,
  PlanOverridesSchema,
  PlanSchema,
  Quota,
} from '@harmoniq/core/dist/schemas/AdminSchemas';
import type { Config } from '../config';

const RANK: Record<Plan, number> = { hobby: 0, startup: 1, enterprise: 2 };
const CACHE_MS = 60_000;
// Bounded: manifest requests look plans up by a slug from the URL, which anyone can vary.
const CACHE_MAX = 10_000;
const LABEL: Record<PlanFeature, string> = {
  byob: 'Bring-your-own-bucket storage',
  approvals: 'Change approvals',
  saml: 'SAML single sign-on',
  scim: 'SCIM provisioning',
};
const FEATURES = Object.keys(LABEL) as PlanFeature[];

const asPlan = (value: string | null | undefined): Plan =>
  PlanSchema.safeParse(value).success ? (value as Plan) : 'hobby';
const higher = (a: Plan, b: Plan) => (RANK[a] >= RANK[b] ? a : b);
const asOverrides = (value: unknown): PlanOverrides => {
  const parsed = PlanOverridesSchema.safeParse(value ?? {});
  return parsed.success ? parsed.data : {};
};

/** A plan as stored on a workspace or organization (PLN-01, PLN-06). */
interface PlanRecord {
  plan: string;
  planOverrides: unknown;
  planExpiresAt: Date | null;
  basePlan: string | null;
}

/** PLN-06: the plan in force: the trial's until it expires, then the base plan. */
export function planInForce(record: PlanRecord | null | undefined, now = new Date()): Plan {
  if (!record) return 'hobby';
  if (record.planExpiresAt && record.planExpiresAt <= now) return asPlan(record.basePlan);
  return asPlan(record.plan);
}

/** What a tenant may use: its plan's features and quotas, with its overrides applied. */
export interface Entitlements {
  plan: Plan;
  features: Record<PlanFeature, boolean>;
  limits: PlanLimits;
}

const PLAN_SELECT = {
  plan: true,
  planOverrides: true,
  planExpiresAt: true,
  basePlan: true,
} as const;

/**
 * PLN-01..06, RL-04: a workspace's plan (its own, or its organization's when higher), what
 * it allows and how much. Without enforcement (self-hosted, PLN-02) every feature is on and
 * nothing is limited; rate limit tiers apply either way. Overrides set by instance admins
 * replace single features and quotas; a workspace's override wins over its organization's.
 * Cached for a minute per replica.
 */
export class Plans {
  private cache = new LRUCache<string, { value: Entitlements; expires: number }>({
    max: CACHE_MAX,
  });

  constructor(
    private deps: {
      systemDb: PrismaClient;
      config: Pick<Config, 'plans' | 'manifestRateLimits'>;
    }
  ) {}

  get enforced() {
    return this.deps.config.plans.enforced;
  }

  private cached(key: string, load: () => Promise<Entitlements>) {
    const hit = this.cache.get(key);
    if (hit && hit.expires > Date.now()) return Promise.resolve(hit.value);
    return load().then((value) => {
      this.cache.set(key, { value, expires: Date.now() + CACHE_MS });
      return value;
    });
  }

  private resolve(plan: Plan, layers: PlanOverrides[]): Entitlements {
    const { features, limits } = this.deps.config.plans;
    const result: Entitlements = {
      plan,
      features: Object.fromEntries(FEATURES.map((f) => [f, features[plan].includes(f)])) as Record<
        PlanFeature,
        boolean
      >,
      limits: { ...limits[plan] },
    };
    // Later layers win (organization, then workspace).
    for (const layer of layers) {
      Object.assign(result.features, layer.features ?? {});
      Object.assign(result.limits, layer.limits ?? {});
    }
    if (!this.enforced) {
      for (const f of FEATURES) result.features[f] = true;
      for (const q of Object.keys(result.limits) as Quota[]) result.limits[q] = null;
    }
    return result;
  }

  /** A workspace's entitlements, by id or slug. */
  async forWorkspace(workspace: { id: string } | { slug: string }): Promise<Entitlements> {
    const key = 'id' in workspace ? `id:${workspace.id}` : `slug:${workspace.slug}`;
    return this.cached(key, async () => {
      const row = await this.deps.systemDb.workspace.findUnique({
        where: 'id' in workspace ? { id: workspace.id } : { slug: workspace.slug },
        select: {
          WorkspaceConfig: { select: PLAN_SELECT },
          organization: { select: { ...PLAN_SELECT, deletedAt: true } },
        },
      });
      const org = row?.organization && !row.organization.deletedAt ? row.organization : null;
      const plan = higher(planInForce(row?.WorkspaceConfig), planInForce(org));
      return this.resolve(plan, [
        asOverrides(org?.planOverrides),
        asOverrides(row?.WorkspaceConfig?.planOverrides),
      ]);
    });
  }

  /** An organization's own entitlements (e.g. how many workspaces it may have). */
  async forOrg(organizationId: string): Promise<Entitlements> {
    return this.cached(`org:${organizationId}`, async () => {
      const org = await this.deps.systemDb.organization.findUnique({
        where: { id: organizationId },
        select: PLAN_SELECT,
      });
      return this.resolve(planInForce(org), [asOverrides(org?.planOverrides)]);
    });
  }

  /** MT-12: an organization's plan by slug (unknown slugs: hobby). */
  async planOfOrgSlug(slug: string): Promise<Plan> {
    const hit = this.cache.get(`orgslug:${slug}`);
    if (hit && hit.expires > Date.now()) return hit.value.plan;
    const org = await this.deps.systemDb.organization.findFirst({
      where: { slug, deletedAt: null },
      select: { id: true },
    });
    const value = org ? await this.forOrg(org.id) : this.resolve('hobby', []);
    this.cache.set(`orgslug:${slug}`, { value, expires: Date.now() + CACHE_MS });
    return value.plan;
  }

  /** The workspace's effective plan, by id or slug. */
  async planOf(workspace: { id: string } | { slug: string }): Promise<Plan> {
    return (await this.forWorkspace(workspace)).plan;
  }

  /** After a plan change. */
  forget() {
    this.cache.clear();
  }

  allows(plan: Plan, feature: PlanFeature) {
    return !this.enforced || this.deps.config.plans.features[plan].includes(feature);
  }

  /** Which features the plan has, for the dashboard. */
  features(plan: Plan): Record<PlanFeature, boolean> {
    return Object.fromEntries(FEATURES.map((f) => [f, this.allows(plan, f)])) as Record<
      PlanFeature,
      boolean
    >;
  }

  private refuse(feature: PlanFeature, plan: Plan): never {
    const needed = (Object.keys(RANK) as Plan[]).find((p) =>
      this.deps.config.plans.features[p].includes(feature)
    );
    throw new PlanRequiredError(
      `${LABEL[feature]} needs ${needed ? `the ${needed} plan` : 'a higher plan'} (this is on ${plan})`,
      { feature, plan, ...(needed && { requiredPlan: needed }) }
    );
  }

  async requireForWorkspace(workspaceId: string, feature: PlanFeature) {
    const e = await this.forWorkspace({ id: workspaceId });
    if (!e.features[feature]) this.refuse(feature, e.plan);
  }

  async requireForOrg(organizationId: string, feature: PlanFeature) {
    const e = await this.forOrg(organizationId);
    if (!e.features[feature]) this.refuse(feature, e.plan);
  }

  /** RL-04: manifest requests per minute for the workspace. */
  async manifestRateLimit(workspaceSlug: string | undefined) {
    const plan = workspaceSlug ? await this.planOf({ slug: workspaceSlug }) : 'hobby';
    return this.deps.config.manifestRateLimits[plan];
  }
}
