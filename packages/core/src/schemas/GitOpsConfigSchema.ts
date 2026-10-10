// Copyright The Harmoniq Authors
// SPDX-License-Identifier: Apache-2.0

import { z } from 'zod';
import { SlugSchema, SpecifierSchema } from './ResourceSchemas';
import { ApprovalPolicySchema } from './ApprovalPolicySchema';
import {
  AlertActionSchema,
  AlertConditionSchema,
  MODULE_ALERT_CONDITIONS,
} from './AlertRuleSchema';
import { WebhookEventNameSchema } from './WebhookEventSchema';

/*
 * IaC-09..12: `harmoniq.yaml`, the declared state of a workspace. Applying it creates and
 * updates what it declares. Optional fields that are left out are not managed (left as
 * they are); `null` clears them. Resources missing from a list are deleted only with
 * `prune`, and only in sections the file has.
 */

const freeze = z
  .object({
    reason: z.string().min(1).max(500),
    /** Scheduled start (ENV-FRZ-04); now when omitted. */
    from: z.coerce.date().optional(),
    until: z.coerce.date().optional(),
  })
  .nullable();

export const GitOpsEnvironmentSchema = z.object({
  slug: SlugSchema,
  name: z.string().min(1).max(120).optional(),
  default: z.boolean().optional(),
  /** APR-01: `null` removes the policy. */
  approvalPolicy: ApprovalPolicySchema.nullable().optional(),
  /** ENV-FRZ: frozen now or in a window; `null` unfreezes. */
  freeze: freeze.optional(),
});

export const GitOpsModuleSchema = z.object({
  slug: SlugSchema,
  name: z.string().min(1).max(120).optional(),
  description: z.string().max(500).nullable().optional(),
  specifier: SpecifierSchema.nullable().optional(),
  /** RBAC-01: members (by email) who own the module; `[]` makes it ownerless. */
  owners: z.array(z.string().email()).max(100).optional(),
});

export const GitOpsHostAppSchema = z.object({
  slug: SlugSchema,
  name: z.string().min(1).max(120).optional(),
  description: z.string().max(500).nullable().optional(),
  default: z.boolean().optional(),
  previewUrlTemplate: z
    .string()
    .url()
    .refine((v) => v.includes('{environment}'), 'Must contain {environment}')
    .nullable()
    .optional(),
  sharedDependencies: z.record(z.string().min(1).max(200)).nullable().optional(),
  strictExposes: z.boolean().optional(),
  environments: z.array(GitOpsEnvironmentSchema).optional(),
  modules: z.array(GitOpsModuleSchema).optional(),
});

export const GitOpsWebhookSchema = z.object({
  url: z.string().url(),
  events: z.array(z.union([WebhookEventNameSchema, z.literal('*')])).min(1),
  active: z.boolean().optional(),
  /**
   * Signing secret. Reference an environment variable (`${HARMONIQ_WEBHOOK_SECRET}`):
   * the CLI substitutes it; a secret never belongs in the file. Generated when omitted.
   */
  secret: z.string().min(16).max(200).optional(),
});

export const GitOpsAlertRuleSchema = z
  .object({
    /** Identifies the rule; unique in the workspace. */
    name: z.string().min(1).max(100),
    condition: AlertConditionSchema,
    threshold: z.number().min(0),
    action: AlertActionSchema,
    /** `module` or `hostApp/module`. */
    module: z.string().min(1).optional(),
    /** Environment slug in the module's host app. */
    environment: SlugSchema.optional(),
    windowMinutes: z.number().int().min(1).max(60).optional(),
    minSamples: z.number().int().min(1).max(100_000).optional(),
    cooldownMinutes: z
      .number()
      .int()
      .min(0)
      .max(24 * 60)
      .optional(),
    enabled: z.boolean().optional(),
  })
  .refine((r) => !MODULE_ALERT_CONDITIONS.includes(r.condition) || (r.module && r.environment), {
    message: 'This condition needs a module and an environment',
  })
  .refine((r) => r.action !== 'auto_rollback' || MODULE_ALERT_CONDITIONS.includes(r.condition), {
    message: 'auto_rollback needs a module condition',
  });

export const GitOpsConfigSchema = z
  .object({
    version: z.literal(1),
    /** When set, applying the file to another workspace is refused. */
    workspace: SlugSchema.optional(),
    hostApps: z.array(GitOpsHostAppSchema).optional(),
    webhooks: z.array(GitOpsWebhookSchema).optional(),
    alertRules: z.array(GitOpsAlertRuleSchema).optional(),
  })
  .strict()
  .superRefine((config, ctx) => {
    const dupes = (values: string[], path: (string | number)[], what: string) => {
      const seen = new Set<string>();
      for (const v of values) {
        if (seen.has(v)) ctx.addIssue({ code: 'custom', path, message: `Duplicate ${what} ${v}` });
        seen.add(v);
      }
    };
    dupes(config.hostApps?.map((h) => h.slug) ?? [], ['hostApps'], 'host app');
    config.hostApps?.forEach((h, i) => {
      dupes(
        h.environments?.map((e) => e.slug) ?? [],
        ['hostApps', i, 'environments'],
        'environment'
      );
      dupes(h.modules?.map((m) => m.slug) ?? [], ['hostApps', i, 'modules'], 'module');
    });
    dupes(config.webhooks?.map((w) => w.url) ?? [], ['webhooks'], 'webhook');
    dupes(config.alertRules?.map((r) => r.name) ?? [], ['alertRules'], 'alert rule');
    if ((config.hostApps?.filter((h) => h.default).length ?? 0) > 1) {
      ctx.addIssue({ code: 'custom', path: ['hostApps'], message: 'Only one default host app' });
    }
  });

export type GitOpsConfig = z.infer<typeof GitOpsConfigSchema>;

export const GitOpsApplyRequestSchema = z.object({
  config: z.unknown(),
  /** Plan only. */
  dryRun: z.boolean().default(false),
  /** Delete resources the file doesn't declare (in the sections it has). */
  prune: z.boolean().default(false),
});

/** One change of a plan. `blocked` changes are reported but never applied. */
export interface GitOpsChange {
  action: 'create' | 'update' | 'delete';
  type:
    | 'hostApp'
    | 'environment'
    | 'module'
    | 'moduleOwners'
    | 'approvalPolicy'
    | 'freeze'
    | 'webhook'
    | 'alertRule';
  /** e.g. `portal`, `portal/production`, `portal/checkout`, a webhook URL or rule name. */
  key: string;
  /** Fields that change (updates). */
  fields?: string[];
  blocked?: string;
}
