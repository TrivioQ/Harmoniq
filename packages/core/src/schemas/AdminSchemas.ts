// Copyright The Harmoniq Authors
// SPDX-License-Identifier: Apache-2.0

import { z } from 'zod';

// INST-01..10: instance administration requests.

/** INST-01..04: the first-boot wizard; every step proves the one-time setup token. */
export const SetupTokenSchema = z.object({ setupToken: z.string().min(1) });

export const SetupCompleteSchema = SetupTokenSchema.extend({
  email: z.string().trim().toLowerCase().email(),
  name: z.string().trim().max(120).optional(),
});

/** INST-09: suspended workspaces stay readable; changes are refused. */
export const SuspendWorkspaceSchema = z.object({
  reason: z.string().trim().max(500).optional(),
});

/** INST-07: grant instance admin to an existing user. */
/** INST-31: instance admin roles. */
export const InstanceAdminRoleSchema = z.enum([
  'instance_owner',
  'instance_operator',
  'instance_support',
  'instance_billing',
]);

export const GrantInstanceAdminSchema = z.object({
  email: z.string().trim().toLowerCase().email(),
  role: InstanceAdminRoleSchema.default('instance_owner'),
});

export const UpdateInstanceAdminSchema = z.object({ role: InstanceAdminRoleSchema });

/** INST-33: instance keys for monitoring and automation. */
export const CreateInstanceApiKeySchema = z.object({
  name: z.string().min(1).max(100),
  scopes: z.array(z.enum(['instance:read', 'instance:admin'])).min(1),
  expiresAt: z.coerce.date().optional(),
});

/** PLN-01: workspace and organization plans. */
export const PlanSchema = z.enum(['hobby', 'startup', 'enterprise']);
export type Plan = z.infer<typeof PlanSchema>;

/** Plan-gated features (PLN-03, BYOB-01, SSO-24). */
export const PlanFeatureSchema = z.enum(['byob', 'approvals', 'saml', 'scim']);
export type PlanFeature = z.infer<typeof PlanFeatureSchema>;

/** PLN-04: numeric quotas. `null` is unlimited. */
export const QuotaSchema = z.enum([
  'workspaces',
  'members',
  'modules',
  'environmentsPerHostApp',
  'storageGb',
  'deploysPerMonth',
  'webhooks',
]);
export type Quota = z.infer<typeof QuotaSchema>;
export type PlanLimits = Record<Quota, number | null>;
export const PlanLimitsSchema = z.record(QuotaSchema, z.number().int().min(0).nullable());
/** `HARMONIQ_PLAN_LIMITS`: quotas by plan (built here: zod's `record` needs one zod copy). */
export const PlanLimitsByPlanSchema = z.record(PlanSchema, PlanLimitsSchema);

/** PLN-06: per-tenant exceptions to its plan, set by instance admins. */
export const PlanOverridesSchema = z.object({
  features: z.record(PlanFeatureSchema, z.boolean()).optional(),
  limits: PlanLimitsSchema.optional(),
});
export type PlanOverrides = z.infer<typeof PlanOverridesSchema>;

/**
 * PLN-01, PLN-06: `overrides` replaces the tenant's overrides (omit to keep them, `null`
 * to clear). `expiresAt` makes `plan` a trial that falls back to `basePlan` (default: the
 * plan before this change).
 */
export const SetPlanSchema = z.object({
  plan: PlanSchema,
  overrides: PlanOverridesSchema.nullable().optional(),
  expiresAt: z.coerce.date().nullable().optional(),
  basePlan: PlanSchema.optional(),
});
