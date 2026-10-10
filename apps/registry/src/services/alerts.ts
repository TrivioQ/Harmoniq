// Copyright The Harmoniq Authors
// SPDX-License-Identifier: Apache-2.0

import type {
  AlertRule,
  Environment,
  HostApp,
  Prisma,
  PrismaClient,
  RemoteModule,
} from '@prisma/client';
import type { TenantTx } from '@harmoniq/db';
import type { ILogger } from '@harmoniq/core/dist/ports/ILogger';
import type { AlertCondition } from '@harmoniq/core/dist/schemas/AlertRuleSchema';
import { windowStats } from './health';
import { ManifestMutations, MutationOutcome } from './manifestMutation';
import { WebhookDispatcher } from './webhookDispatcher';
import { deactivateActive, endCanary, findCanary } from './modules';

type RuleWithTarget = AlertRule & {
  workspace: { id: string; slug: string };
  remoteModule: (RemoteModule & { hostApp: HostApp }) | null;
  environment: Environment | null;
};

export interface AlertDeps {
  systemDb: PrismaClient;
  withTenant: <T>(workspaceId: string, fn: (tx: TenantTx) => Promise<T>) => Promise<T>;
  mutations: ManifestMutations;
  webhooks: WebhookDispatcher;
  logger: ILogger;
}

/** Lower is worse for success rates; higher is worse for everything else. */
export const isBreach = (condition: string, value: number, threshold: number) =>
  condition === 'load_success_rate' ? value < threshold : value > threshold;

/**
 * The rule's metric over its window, or null when there are fewer than `minSamples`
 * samples (no decision on thin data).
 */
export async function measure(
  tx: TenantTx,
  rule: RuleWithTarget,
  now: Date
): Promise<number | null> {
  const from = new Date(now.getTime() - rule.windowMinutes * 60_000);
  const condition = rule.condition as AlertCondition;

  if (condition === 'webhook_failure_rate') {
    const [total, failed] = await Promise.all([
      tx.webhookDelivery.count({ where: { createdAt: { gte: from } } }),
      tx.webhookDelivery.count({ where: { createdAt: { gte: from }, success: false } }),
    ]);
    return total >= rule.minSamples ? failed / total : null;
  }

  if (!rule.remoteModuleId || !rule.environmentId) return null;
  const { overall, variants } = await windowStats(
    tx,
    rule.remoteModuleId,
    rule.environmentId,
    from,
    now
  );
  const { canary, stable } = variants;
  const errorRate = (s: { sampleCount: number; errorCount: number }) =>
    s.errorCount / s.sampleCount;

  switch (condition) {
    case 'canary_error_rate':
      return canary.sampleCount >= rule.minSamples ? errorRate(canary) : null;
    case 'canary_error_rate_delta':
      return canary.sampleCount >= rule.minSamples && stable.sampleCount >= rule.minSamples
        ? errorRate(canary) - errorRate(stable)
        : null;
    case 'canary_load_p95ms':
      return canary.sampleCount >= rule.minSamples ? canary.p95LoadMs : null;
    case 'load_success_rate':
      return overall.sampleCount >= rule.minSamples ? overall.loadSuccessRate : null;
    case 'load_p95ms':
      return overall.sampleCount >= rule.minSamples ? overall.p95LoadMs : null;
    default:
      return null;
  }
}

/**
 * ALT-03/04: aborts the running canary, or (for conditions about the module as a whole)
 * rolls it back to the previous version, through the mutation pipeline as `system`.
 * Returns what was done, or null when there was nothing to roll back.
 */
async function autoRollback(deps: AlertDeps, rule: RuleWithTarget, value: number) {
  const module = rule.remoteModule!;
  const environment = rule.environment!;
  const target = { workspace: rule.workspace, hostApp: module.hostApp, environment };
  const actor = { principal: { type: 'system' as const, id: `alert:${rule.id}` } };
  const trigger = {
    ruleId: rule.id,
    ruleName: rule.name,
    condition: rule.condition,
    threshold: rule.threshold,
    value,
  };
  const canaryCondition = rule.condition.startsWith('canary_');

  const { result } = await deps.mutations.run(target, actor, async (tx) => {
    const canary = await findCanary(tx, module.id, environment.id);
    if (canary) {
      await endCanary(tx, module.id, environment.id);
      const change = { module: module.slug, version: canary.version, versionId: canary.id };
      return {
        result: { kind: 'canary_aborted', version: canary.version },
        audit: {
          action: 'module.auto_rollback',
          resourceType: 'moduleVersion',
          resourceId: canary.id,
          metadata: {
            ...change,
            environment: environment.slug,
            kind: 'canary_aborted',
            ...trigger,
          },
        },
        events: [{ name: 'canary.auto_rolled_back', payload: { ...change, ...trigger } }],
      } satisfies MutationOutcome<unknown>;
    }
    if (canaryCondition) throw new NothingToDo('No canary running');

    const scope = { remoteModuleId: module.id, environmentId: environment.id, deletedAt: null };
    const current = await tx.moduleVersion.findFirst({ where: { ...scope, status: 'active' } });
    const previous =
      current &&
      (await tx.moduleVersion.findFirst({
        where: {
          ...scope,
          status: 'inactive',
          activatedAt: { not: null }, // never an aborted canary
          deployedAt: { lt: current.deployedAt },
        },
        orderBy: { deployedAt: 'desc' },
      }));
    if (!current || !previous) throw new NothingToDo('No previous version to roll back to');
    await deactivateActive(tx, module.id, environment.id);
    await tx.moduleVersion.update({
      where: { id: previous.id },
      data: { status: 'active', activatedAt: new Date() },
    });
    const change = {
      module: module.slug,
      fromVersion: current.version,
      toVersion: previous.version,
      versionId: previous.id,
    };
    return {
      result: { kind: 'rolled_back', version: previous.version },
      audit: {
        action: 'module.auto_rollback',
        resourceType: 'moduleVersion',
        resourceId: previous.id,
        metadata: { ...change, environment: environment.slug, kind: 'rolled_back', ...trigger },
      },
      events: [
        { name: 'module.auto_rolled_back', payload: { ...change, ...trigger } },
        { name: 'rollback.executed', payload: change },
      ],
    } satisfies MutationOutcome<unknown>;
  });
  return result;
}

class NothingToDo extends Error {}

/** Evaluates one rule; fires or resolves it on a state change. */
export async function evaluateRule(deps: AlertDeps, rule: RuleWithTarget, now = new Date()) {
  const value = await deps.withTenant(rule.workspaceId, (tx) => measure(tx, rule, now));
  const breaching = value !== null && isBreach(rule.condition, value, rule.threshold);
  const coolingDown =
    !!rule.lastTriggeredAt &&
    now.getTime() - rule.lastTriggeredAt.getTime() < rule.cooldownMinutes * 60_000;
  const payload = {
    rule: {
      id: rule.id,
      name: rule.name,
      condition: rule.condition,
      threshold: rule.threshold,
      action: rule.action,
    },
    value,
    module: rule.remoteModule?.slug ?? null,
    environment: rule.environment?.slug ?? null,
  };

  const update: Prisma.AlertRuleUncheckedUpdateInput = { lastValue: value, lastEvaluatedAt: now };
  if (breaching && rule.state === 'ok' && !coolingDown) {
    update.state = 'firing';
    update.lastTriggeredAt = now;
    update.lastError = null;
    let outcome: unknown = null;
    if (rule.action === 'auto_rollback') {
      try {
        outcome = await autoRollback(deps, rule, value!);
      } catch (err) {
        // A frozen environment (423) blocks the rollback too; the alert still goes out.
        update.lastError = (err as Error).message;
        if (!(err instanceof NothingToDo)) {
          deps.logger.error(`Auto-rollback for alert ${rule.id} failed`, err as Error);
        }
      }
    }
    await deps.webhooks.dispatch(rule.workspaceId, 'alert.triggered', {
      ...payload,
      ...(outcome ? { autoRollback: outcome } : {}),
      ...(update.lastError ? { autoRollbackError: update.lastError } : {}),
    });
  } else if (!breaching && rule.state === 'firing') {
    update.state = 'ok';
    await deps.webhooks.dispatch(rule.workspaceId, 'alert.resolved', payload);
  }
  await deps.systemDb.alertRule.update({ where: { id: rule.id }, data: update });
  return { value, breaching, state: update.state ?? rule.state };
}

/** ALT-05: every enabled rule, every minute. One failing rule doesn't stop the others. */
export async function evaluateAlerts(deps: AlertDeps, now = new Date()) {
  const rules = await deps.systemDb.alertRule.findMany({
    where: { enabled: true },
    include: {
      workspace: { select: { id: true, slug: true } },
      remoteModule: { include: { hostApp: true } },
      environment: true,
    },
  });
  let fired = 0;
  for (const rule of rules) {
    try {
      const result = await evaluateRule(deps, rule, now);
      if (result.breaching && result.state === 'firing' && rule.state === 'ok') fired++;
    } catch (err) {
      deps.logger.error(`Evaluating alert ${rule.id} failed`, err as Error);
    }
  }
  return { evaluated: rules.length, fired };
}
