// Copyright The Harmoniq Authors
// SPDX-License-Identifier: Apache-2.0

import type { PrismaClient } from '@prisma/client';
import { PlanRequiredError } from '@harmoniq/core/dist/errors/AppError';
import { Plan, PlanFeature, PlanSchema } from '@harmoniq/core/dist/schemas/AdminSchemas';
import type { Config } from '../config';

const RANK: Record<Plan, number> = { hobby: 0, startup: 1, enterprise: 2 };
const CACHE_MS = 60_000;
const LABEL: Record<PlanFeature, string> = {
  byob: 'Bring-your-own-bucket storage',
  approvals: 'Change approvals',
  saml: 'SAML single sign-on',
  scim: 'SCIM provisioning',
};

const asPlan = (value: string | null | undefined): Plan =>
  PlanSchema.safeParse(value).success ? (value as Plan) : 'hobby';
const higher = (a: Plan, b: Plan) => (RANK[a] >= RANK[b] ? a : b);

/**
 * PLN-01..03, RL-04: a workspace's plan (its own, or its organization's when higher) and
 * what it allows. Without enforcement (self-hosted, PLN-02) every plan has every feature;
 * rate limit tiers apply either way. Plans are cached for a minute per replica.
 */
export class Plans {
  private cache = new Map<string, { plan: Plan; expires: number }>();

  constructor(
    private deps: { systemDb: PrismaClient; config: Pick<Config, 'plans' | 'manifestRateLimits'> }
  ) {}

  get enforced() {
    return this.deps.config.plans.enforced;
  }

  /** The workspace's effective plan, by id or slug. */
  async planOf(workspace: { id: string } | { slug: string }): Promise<Plan> {
    const key = 'id' in workspace ? `id:${workspace.id}` : `slug:${workspace.slug}`;
    const hit = this.cache.get(key);
    if (hit && hit.expires > Date.now()) return hit.plan;
    const row = await this.deps.systemDb.workspace.findUnique({
      where: 'id' in workspace ? { id: workspace.id } : { slug: workspace.slug },
      select: {
        WorkspaceConfig: { select: { plan: true } },
        organization: { select: { plan: true, deletedAt: true } },
      },
    });
    const own = asPlan(row?.WorkspaceConfig?.plan);
    const org =
      row?.organization && !row.organization.deletedAt ? asPlan(row.organization.plan) : 'hobby';
    const plan = higher(own, org);
    this.cache.set(key, { plan, expires: Date.now() + CACHE_MS });
    return plan;
  }

  async orgPlan(organizationId: string): Promise<Plan> {
    const org = await this.deps.systemDb.organization.findUnique({
      where: { id: organizationId },
      select: { plan: true },
    });
    return asPlan(org?.plan);
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
    return Object.fromEntries(
      (Object.keys(LABEL) as PlanFeature[]).map((f) => [f, this.allows(plan, f)])
    ) as Record<PlanFeature, boolean>;
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
    const plan = await this.planOf({ id: workspaceId });
    if (!this.allows(plan, feature)) this.refuse(feature, plan);
  }

  async requireForOrg(organizationId: string, feature: PlanFeature) {
    const plan = await this.orgPlan(organizationId);
    if (!this.allows(plan, feature)) this.refuse(feature, plan);
  }

  /** RL-04: manifest requests per minute for the workspace. */
  async manifestRateLimit(workspaceSlug: string | undefined) {
    const plan = workspaceSlug ? await this.planOf({ slug: workspaceSlug }) : 'hobby';
    return this.deps.config.manifestRateLimits[plan];
  }
}
