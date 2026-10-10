// Copyright The Harmoniq Authors
// SPDX-License-Identifier: Apache-2.0

import { Prisma } from '@prisma/client';
import type { Environment, HostApp, ModuleVersion, RemoteModule } from '@prisma/client';
import type { RolloutSchedule } from '@harmoniq/core/dist/schemas/CanaryRequestSchema';
import type { HealthStats } from '@harmoniq/core/dist/schemas/HealthReportSchema';
import { ConflictError } from '@harmoniq/core/dist/errors/AppError';
import type { AlertDeps } from './alerts';
import type { AuditActor } from './audit';
import { windowStats } from './health';
import { MutationOutcome } from './manifestMutation';
import { deactivateActive, endCanary, findCanary } from './modules';

/** What is stored in `ModuleVersion.rolloutSchedule`. */
export type StoredRollout = RolloutSchedule & { bandStartedAt: string };

export type RolloutDeps = AlertDeps;

type CanaryWithTarget = ModuleVersion & {
  remoteModule: RemoteModule & { hostApp: HostApp };
  environment: Environment;
  workspace: { id: string; slug: string };
};

export const rolloutOf = (v: Pick<ModuleVersion, 'rolloutSchedule'>) =>
  (v.rolloutSchedule as StoredRollout | null) ?? null;

export function startRollout(schedule: RolloutSchedule, now = new Date()) {
  const stored: StoredRollout = { ...schedule, bandStartedAt: now.toISOString() };
  return {
    trafficPercent: schedule.bands[0].percent,
    rolloutSchedule: stored as unknown as Prisma.InputJsonValue,
    currentBandIndex: 0,
  };
}

/** Fields that stop a staged rollout (manual traffic, promote, abort). */
export const clearedRollout = {
  rolloutSchedule: Prisma.DbNull,
  currentBandIndex: null,
};

export type GateResult =
  | { verdict: 'pass'; canary: HealthStats; stable: HealthStats }
  | { verdict: 'fail'; reasons: string[]; canary: HealthStats; stable: HealthStats }
  | { verdict: 'wait'; canary: HealthStats; stable: HealthStats };

/** STG-02: the gate over the canary's loads during the band. */
export function checkGate(
  gate: RolloutSchedule['gate'],
  canary: HealthStats,
  stable: HealthStats
): GateResult {
  if (canary.sampleCount < gate.minSamples) return { verdict: 'wait', canary, stable };
  const errorRate = (s: HealthStats) => (s.sampleCount ? s.errorCount / s.sampleCount : 0);
  const reasons: string[] = [];
  if (gate.maxErrorRate !== undefined && errorRate(canary) > gate.maxErrorRate) {
    reasons.push(`error rate ${errorRate(canary).toFixed(3)} > ${gate.maxErrorRate}`);
  }
  if (gate.maxErrorRateDelta !== undefined && stable.sampleCount) {
    const delta = errorRate(canary) - errorRate(stable);
    if (delta > gate.maxErrorRateDelta) {
      reasons.push(`error rate ${delta.toFixed(3)} above stable (max ${gate.maxErrorRateDelta})`);
    }
  }
  if (gate.maxP95Ms !== undefined && (canary.p95LoadMs ?? 0) > gate.maxP95Ms) {
    reasons.push(`p95 ${canary.p95LoadMs} ms > ${gate.maxP95Ms} ms`);
  }
  return reasons.length
    ? { verdict: 'fail', reasons, canary, stable }
    : { verdict: 'pass', canary, stable };
}

class Stale extends Error {}

/**
 * Moves the canary to its next band, or promotes it when that band is 100% (STG-03).
 * `expectedBand` guards against a manual advance and the job racing each other.
 */
export async function advanceRollout(
  deps: Pick<RolloutDeps, 'mutations'>,
  target: {
    workspace: { id: string; slug: string };
    hostApp: HostApp;
    environment: Environment;
    module: RemoteModule;
  },
  actor: AuditActor,
  opts: { expectedBand?: number; gate?: GateResult; manual: boolean }
) {
  const { module, environment } = target;
  return deps.mutations.run(target, actor, async (tx) => {
    const canary = await findCanary(tx, module.id, environment.id);
    const rollout = canary && rolloutOf(canary);
    if (!canary || !rollout || canary.currentBandIndex === null) {
      throw new ConflictError(`No staged rollout of "${module.slug}" in "${environment.slug}"`);
    }
    if (opts.expectedBand !== undefined && canary.currentBandIndex !== opts.expectedBand) {
      throw new Stale();
    }
    const nextIndex = canary.currentBandIndex + 1;
    const next = rollout.bands[nextIndex];
    const base = {
      module: module.slug,
      version: canary.version,
      versionId: canary.id,
      band: nextIndex + 1,
      bands: rollout.bands.length,
      manual: opts.manual,
      ...(opts.gate && { canary: opts.gate.canary, stable: opts.gate.stable }),
    };

    if (next.percent === 100) {
      await deactivateActive(tx, module.id, environment.id);
      const promoted = await tx.moduleVersion.update({
        where: { id: canary.id },
        data: {
          status: 'active',
          trafficPercent: null,
          targeting: Prisma.DbNull,
          activatedAt: new Date(),
          ...clearedRollout,
        },
      });
      return {
        result: promoted,
        audit: {
          action: 'canary.promote',
          resourceType: 'moduleVersion',
          resourceId: promoted.id,
          metadata: { ...base, environment: environment.slug, rollout: true },
        },
        events: [{ name: 'canary.promoted', payload: { ...base, rollout: true } }],
      } satisfies MutationOutcome<ModuleVersion>;
    }

    const updated = await tx.moduleVersion.update({
      where: { id: canary.id },
      data: {
        trafficPercent: next.percent,
        currentBandIndex: nextIndex,
        rolloutSchedule: {
          ...rollout,
          bandStartedAt: new Date().toISOString(),
        } as unknown as Prisma.InputJsonValue,
      },
    });
    const change = {
      ...base,
      fromTrafficPercent: canary.trafficPercent,
      trafficPercent: next.percent,
    };
    return {
      result: updated,
      audit: {
        action: 'canary.rollout_advance',
        resourceType: 'moduleVersion',
        resourceId: updated.id,
        metadata: { ...change, environment: environment.slug },
      },
      events: [{ name: 'canary.updated', payload: change }],
    } satisfies MutationOutcome<ModuleVersion>;
  });
}

/** STG-04: a failed gate aborts the canary, as `system`. */
async function failRollout(deps: RolloutDeps, canary: CanaryWithTarget, gate: GateResult) {
  const { remoteModule: module, environment, workspace } = canary;
  const actor = { principal: { type: 'system' as const, id: 'rollout' } };
  await deps.mutations.run(
    { workspace, hostApp: module.hostApp, environment },
    actor,
    async (tx) => {
      const current = await findCanary(tx, module.id, environment.id);
      if (current?.id !== canary.id || current.currentBandIndex !== canary.currentBandIndex) {
        throw new Stale();
      }
      await endCanary(tx, module.id, environment.id);
      await tx.moduleVersion.update({ where: { id: canary.id }, data: clearedRollout });
      const change = {
        module: module.slug,
        version: canary.version,
        versionId: canary.id,
        band: (canary.currentBandIndex ?? 0) + 1,
        trafficPercent: canary.trafficPercent,
        reasons: gate.verdict === 'fail' ? gate.reasons : [],
        canary: gate.canary,
        stable: gate.stable,
      };
      return {
        result: null,
        audit: {
          action: 'canary.rollout_failed',
          resourceType: 'moduleVersion',
          resourceId: canary.id,
          metadata: { ...change, environment: environment.slug },
        },
        events: [{ name: 'canary.auto_rolled_back', payload: { ...change, rollout: true } }],
      } satisfies MutationOutcome<null>;
    }
  );
}

/**
 * The `rollout.advance` job (every minute): for each staged canary whose band has run
 * its hold time, check the gate and advance, promote or abort. A frozen environment
 * (423) just leaves the rollout where it is until the freeze ends.
 */
export async function evaluateRollouts(deps: RolloutDeps, now = new Date()) {
  const canaries = (await deps.systemDb.moduleVersion.findMany({
    where: {
      status: 'canary',
      deletedAt: null,
      currentBandIndex: { not: null },
    },
    include: {
      remoteModule: { include: { hostApp: true } },
      environment: true,
      workspace: { select: { id: true, slug: true } },
    },
  })) as CanaryWithTarget[];

  const results: Array<{ versionId: string; outcome: string }> = [];
  for (const canary of canaries) {
    const rollout = rolloutOf(canary);
    if (!rollout || canary.currentBandIndex === null) continue;
    const band = rollout.bands[canary.currentBandIndex];
    const bandStartedAt = new Date(rollout.bandStartedAt);
    if (now.getTime() - bandStartedAt.getTime() < band.holdMinutes * 60_000) continue;

    try {
      const { variants } = await deps.withTenant(canary.workspaceId, (tx) =>
        windowStats(tx, canary.remoteModuleId, canary.environmentId, bandStartedAt, now)
      );
      const gate = checkGate(rollout.gate, variants.canary, variants.stable);
      if (gate.verdict === 'wait') {
        results.push({ versionId: canary.id, outcome: 'waiting_for_samples' });
      } else if (gate.verdict === 'fail') {
        await failRollout(deps, canary, gate);
        results.push({ versionId: canary.id, outcome: 'aborted' });
      } else {
        await advanceRollout(
          deps,
          {
            workspace: canary.workspace,
            hostApp: canary.remoteModule.hostApp,
            environment: canary.environment,
            module: canary.remoteModule,
          },
          { principal: { type: 'system', id: 'rollout' } },
          { expectedBand: canary.currentBandIndex, gate, manual: false }
        );
        results.push({ versionId: canary.id, outcome: 'advanced' });
      }
    } catch (err) {
      if (err instanceof Stale) continue; // changed by hand meanwhile
      results.push({ versionId: canary.id, outcome: `error: ${(err as Error).message}` });
      if ((err as { statusCode?: number }).statusCode !== 423) {
        deps.logger.error(`Rollout of ${canary.id} failed`, err as Error);
      }
    }
  }
  return results;
}
