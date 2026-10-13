// Copyright The Harmoniq Authors
// SPDX-License-Identifier: Apache-2.0

import { z } from 'zod';
import { ApprovalPolicySchema } from './ApprovalPolicySchema';
import { ApiKeyScopeSchema } from './ApiKeyCreateSchema';

/**
 * An environment slug pattern: a slug where `*` matches any run of characters,
 * e.g. `production`, `prod-*` or `*`.
 */
export const EnvironmentPatternSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9*-]+$/, 'Use lowercase letters, digits, hyphens and *');

/** POL-02: the approval policy every workspace gets for environments matching the pattern. */
export const ApprovalDefaultSchema = ApprovalPolicySchema.extend({
  environmentPattern: EnvironmentPatternSchema,
});

/** POL-05: an organization-wide freeze of matching environments. */
export const OrgFreezeWindowSchema = z
  .object({
    /** Kept across saves so overrides stay attached; generated when missing. */
    id: z.string().min(1).max(40).optional(),
    environmentPattern: EnvironmentPatternSchema,
    /** Open-ended when missing. */
    from: z.coerce.date().optional(),
    until: z.coerce.date().optional(),
    reason: z.string().min(1).max(500),
  })
  .refine((w) => !w.from || !w.until || w.from < w.until, '`from` must be before `until`');

/** POL-01: the whole policy; `PUT` replaces it (missing fields take their defaults). */
export const OrgPolicySchema = z.object({
  approvalDefaults: z.array(ApprovalDefaultSchema).max(20).default([]),
  /** POL-03: keys must expire within this many days. */
  maxApiKeyDays: z.number().int().min(1).max(3650).nullable().default(null),
  /** POL-03: empty allows every scope. */
  allowedKeyScopes: z.array(ApiKeyScopeSchema).default([]),
  /** POL-04 */
  minRetentionDays: z.number().int().min(1).max(3650).nullable().default(null),
  freezeWindows: z.array(OrgFreezeWindowSchema).max(50).default([]),
  /** POL-06 */
  lockSso: z.boolean().default(false),
  /** SES-03: members signing in without SSO must use MFA. */
  requireMfa: z.boolean().default(false),
  /** POL-07 */
  sessionMaxHours: z
    .number()
    .int()
    .min(1)
    .max(24 * 365)
    .nullable()
    .default(null),
  idleTimeoutMinutes: z
    .number()
    .int()
    .min(5)
    .max(60 * 24 * 30)
    .nullable()
    .default(null),
  /** POL-08: CIDR blocks (`10.0.0.0/8`, `2001:db8::/32`) or single addresses. */
  ipAllowlist: z.array(z.string().min(2).max(64)).max(100).default([]),
  /** POL-08: apply the allowlist to manifest and health endpoints too. */
  ipAllowlistManifests: z.boolean().default(false),
});

export type OrgPolicyInput = z.infer<typeof OrgPolicySchema>;

/** POL-05: the org admin override of an org freeze window (ENV-FRZ-03 semantics). */
export const OrgFreezeOverrideSchema = z.object({
  until: z.coerce.date(),
  reason: z.string().min(1).max(500),
});
