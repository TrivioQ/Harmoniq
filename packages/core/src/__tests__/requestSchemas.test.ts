// Copyright The Harmoniq Authors
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from 'vitest';
import type { ZodTypeAny } from 'zod';
import { DeployRequestSchema } from '../schemas/DeployRequestSchema';
import {
  KillSwitchRequestSchema,
  RolloutScheduleSchema,
  SetCanaryRequestSchema,
} from '../schemas/CanaryRequestSchema';
import { FreezeRequestSchema, RollbackRequestSchema } from '../schemas/RollbackRequestSchema';
import { CreateAlertRuleSchema, UpdateAlertRuleSchema } from '../schemas/AlertRuleSchema';
import { CreateScheduledOperationSchema } from '../schemas/ScheduledOperationSchema';
import { ApprovalPolicySchema } from '../schemas/ApprovalPolicySchema';
import { ApprovalBypassSchema } from '../schemas/ApprovalDecisionSchema';

/** The first issue's message, or null when the value is valid. */
const problem = (schema: ZodTypeAny, value: unknown) => {
  const result = schema.safeParse(value);
  return result.success ? null : result.error.issues[0].message;
};

const deploy = {
  environment: 'production',
  url: 'https://cdn.example.com/checkout/1.0.0/remoteEntry.js',
  version: '1.0.0',
  integrity: 'sha384-abc+/=',
};

describe('deploy and canary requests', () => {
  it('accepts a plain deploy and rejects a non-SRI integrity', () => {
    expect(DeployRequestSchema.parse(deploy).dryRun).toBe(false);
    expect(problem(DeployRequestSchema, { ...deploy, integrity: 'md5-x' })).toBe(
      'Expected an SRI hash'
    );
  });

  it('takes a canary percentage or a rollout, not both', () => {
    const rollout = {
      bands: [
        { percent: 10, holdMinutes: 30 },
        { percent: 100, holdMinutes: 0 },
      ],
    };
    expect(problem(DeployRequestSchema, { ...deploy, canary: { trafficPercent: 10 } })).toBeNull();
    expect(problem(DeployRequestSchema, { ...deploy, canary: { rollout } })).toBeNull();
    expect(
      problem(DeployRequestSchema, { ...deploy, canary: { trafficPercent: 10, rollout } })
    ).toBe('Give either trafficPercent or rollout');
    expect(problem(DeployRequestSchema, { ...deploy, canary: { trafficPercent: 0 } })).toBe(
      'trafficPercent 0 needs targeting rules'
    );
    expect(
      problem(DeployRequestSchema, {
        ...deploy,
        canary: { trafficPercent: 0, targeting: [{ attribute: 'tenant', values: ['beta'] }] },
      })
    ).toBeNull();
  });

  it('needs increasing rollout bands ending at 100', () => {
    const band = (percent: number) => ({ percent, holdMinutes: 5 });
    expect(RolloutScheduleSchema.parse({ bands: [band(5), band(100)] }).gate.minSamples).toBe(20);
    expect(problem(RolloutScheduleSchema, { bands: [band(50), band(10), band(100)] })).toBe(
      'Band percentages must increase'
    );
    expect(problem(RolloutScheduleSchema, { bands: [band(5), band(50)] })).toBe(
      'The last band must be 100 (promote)'
    );
  });

  it('changes a canary with traffic, targeting or both', () => {
    expect(problem(SetCanaryRequestSchema, { environment: 'prod', trafficPercent: 20 })).toBeNull();
    expect(problem(SetCanaryRequestSchema, { environment: 'prod', targeting: [] })).toBeNull();
    expect(problem(SetCanaryRequestSchema, { environment: 'prod' })).toBe(
      'Give trafficPercent, targeting or both'
    );
    expect(
      problem(SetCanaryRequestSchema, { environment: 'prod', versionId: 'v1', targeting: [] })
    ).toBe('Starting a version as the canary needs trafficPercent');
  });

  it('needs a reason to switch a module off', () => {
    expect(problem(KillSwitchRequestSchema, { environment: 'prod', disabled: false })).toBeNull();
    expect(
      problem(KillSwitchRequestSchema, { environment: 'prod', disabled: true, reason: 'crash' })
    ).toBeNull();
    expect(
      problem(KillSwitchRequestSchema, { environment: 'prod', disabled: true, reason: ' x ' })
    ).toMatch(/Say why/);
  });
});

describe('rollback and freeze requests', () => {
  it('rolls back to exactly one target', () => {
    expect(problem(RollbackRequestSchema, { environment: 'prod', previous: true })).toBeNull();
    expect(problem(RollbackRequestSchema, { environment: 'prod', version: '1.0.0' })).toBeNull();
    expect(problem(RollbackRequestSchema, { environment: 'prod' })).toMatch(/exactly one/);
    expect(
      problem(RollbackRequestSchema, { environment: 'prod', versionId: 'a', previous: true })
    ).toMatch(/exactly one/);
  });

  it('freezes with a window that starts before it ends', () => {
    const from = '2026-12-24T00:00:00Z';
    const until = '2026-12-27T00:00:00Z';
    expect(problem(FreezeRequestSchema, { reason: 'holidays', from, until })).toBeNull();
    expect(problem(FreezeRequestSchema, { reason: 'holidays', from: until, until: from })).toBe(
      '`from` must be before `until`'
    );
  });
});

describe('alert rules', () => {
  const rule = { name: 'errors', threshold: 0.05, action: 'webhook' } as const;

  it('needs a module and environment for module conditions', () => {
    const parsed = CreateAlertRuleSchema.parse({
      ...rule,
      condition: 'canary_error_rate',
      module: 'checkout',
      environment: 'production',
    });
    expect(parsed).toMatchObject({ windowMinutes: 5, minSamples: 20, enabled: true });
    expect(problem(CreateAlertRuleSchema, { ...rule, condition: 'load_p95ms' })).toBe(
      'This condition needs a module and an environment'
    );
    expect(
      problem(CreateAlertRuleSchema, { ...rule, condition: 'webhook_failure_rate' })
    ).toBeNull();
  });

  it('rolls back only on module conditions, and rates are fractions', () => {
    expect(
      problem(CreateAlertRuleSchema, {
        ...rule,
        condition: 'webhook_failure_rate',
        action: 'auto_rollback',
      })
    ).toBe('auto_rollback needs a module condition');
    expect(
      problem(CreateAlertRuleSchema, { ...rule, condition: 'webhook_failure_rate', threshold: 5 })
    ).toBe('Rates are fractions between 0 and 1');
    expect(
      problem(CreateAlertRuleSchema, {
        ...rule,
        condition: 'load_p95ms',
        threshold: 800,
        module: 'checkout',
        environment: 'production',
      })
    ).toBeNull();
    expect(UpdateAlertRuleSchema.parse({ enabled: false })).toEqual({ enabled: false });
  });
});

describe('scheduled operations and approvals', () => {
  it('validates the scheduled call with its route schema', () => {
    const runAt = '2026-11-01T09:00:00+01:00';
    expect(
      problem(CreateScheduledOperationSchema, {
        runAt,
        operation: { type: 'deploy', module: 'checkout', request: deploy },
      })
    ).toBeNull();
    expect(
      problem(CreateScheduledOperationSchema, {
        runAt,
        operation: { type: 'rollback', module: 'checkout', request: { environment: 'prod' } },
      })
    ).toMatch(/exactly one/);
    expect(
      problem(CreateScheduledOperationSchema, {
        runAt: 'tomorrow',
        operation: { type: 'canary_abort', module: 'checkout', request: { environment: 'p' } },
      })
    ).not.toBeNull();
  });

  it('needs an {id} in ticket links and a real justification to bypass', () => {
    expect(ApprovalPolicySchema.parse({ eligibleRoles: ['admin'] })).toMatchObject({
      requiredApprovers: 1,
      expiryHours: 24,
    });
    expect(
      problem(ApprovalPolicySchema, {
        eligibleRoles: ['admin'],
        ticketUrlPattern: 'https://jira.example.com/browse/',
      })
    ).toBe('Must contain {id}');
    expect(
      problem(ApprovalBypassSchema, { bypassJustification: '   too short   ' })
    ).not.toBeNull();
  });
});
