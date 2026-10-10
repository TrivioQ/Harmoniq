// Copyright The Harmoniq Authors
// SPDX-License-Identifier: Apache-2.0

import { z } from 'zod';

/**
 * ALT-02 / HLT-05. Rates are fractions (0–1), times are milliseconds. Module conditions
 * need a module and an environment; `webhook_failure_rate` is workspace-wide.
 */
export const AlertConditionSchema = z.enum([
  /** Failed share of canary loads > threshold. */
  'canary_error_rate',
  /** Canary error rate minus stable error rate > threshold. */
  'canary_error_rate_delta',
  /** p95 load time of the canary > threshold. */
  'canary_load_p95ms',
  /** Overall load success rate < threshold. */
  'load_success_rate',
  /** Overall p95 load time > threshold. */
  'load_p95ms',
  /** Failed share of webhook deliveries > threshold. */
  'webhook_failure_rate',
]);
export type AlertCondition = z.infer<typeof AlertConditionSchema>;

export const MODULE_ALERT_CONDITIONS: AlertCondition[] = [
  'canary_error_rate',
  'canary_error_rate_delta',
  'canary_load_p95ms',
  'load_success_rate',
  'load_p95ms',
];

/**
 * ALT-03. `webhook` sends `alert.triggered` / `alert.resolved` to the workspace's webhook
 * endpoints subscribed to them. `auto_rollback` also aborts the module's canary, or rolls
 * it back to the previous version when no canary is running.
 */
export const AlertActionSchema = z.enum(['webhook', 'auto_rollback']);
export type AlertAction = z.infer<typeof AlertActionSchema>;

const ruleFields = {
  name: z.string().min(1).max(100),
  threshold: z.number().min(0),
  windowMinutes: z.number().int().min(1).max(60).default(5),
  minSamples: z.number().int().min(1).max(100_000).default(20),
  cooldownMinutes: z
    .number()
    .int()
    .min(0)
    .max(24 * 60)
    .default(15),
  enabled: z.boolean().default(true),
};

export const CreateAlertRuleSchema = z
  .object({
    ...ruleFields,
    condition: AlertConditionSchema,
    action: AlertActionSchema,
    /** Module slug or id; required for module conditions. */
    module: z.string().min(1).optional(),
    /** Environment slug (in the module's host app); required for module conditions. */
    environment: z.string().min(1).optional(),
  })
  .refine((r) => !MODULE_ALERT_CONDITIONS.includes(r.condition) || (r.module && r.environment), {
    message: 'This condition needs a module and an environment',
  })
  .refine((r) => r.action !== 'auto_rollback' || MODULE_ALERT_CONDITIONS.includes(r.condition), {
    message: 'auto_rollback needs a module condition',
  })
  .refine(
    (r) => (!r.condition.endsWith('rate') && !r.condition.endsWith('delta')) || r.threshold <= 1,
    {
      message: 'Rates are fractions between 0 and 1',
    }
  );
export type CreateAlertRule = z.infer<typeof CreateAlertRuleSchema>;

export const UpdateAlertRuleSchema = z
  .object({
    name: ruleFields.name,
    threshold: ruleFields.threshold,
    windowMinutes: z.number().int().min(1).max(60),
    minSamples: z.number().int().min(1).max(100_000),
    cooldownMinutes: z
      .number()
      .int()
      .min(0)
      .max(24 * 60),
    enabled: z.boolean(),
    action: AlertActionSchema,
  })
  .partial();
export type UpdateAlertRule = z.infer<typeof UpdateAlertRuleSchema>;
