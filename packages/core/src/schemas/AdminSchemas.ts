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
export const GrantInstanceAdminSchema = z.object({
  email: z.string().trim().toLowerCase().email(),
});

/** PLN-01: workspace and organization plans. */
export const PlanSchema = z.enum(['hobby', 'startup', 'enterprise']);
export type Plan = z.infer<typeof PlanSchema>;

/** Plan-gated features (PLN-03, BYOB-01, SSO-24). */
export const PlanFeatureSchema = z.enum(['byob', 'approvals', 'saml', 'scim']);
export type PlanFeature = z.infer<typeof PlanFeatureSchema>;

export const SetPlanSchema = z.object({ plan: PlanSchema });
