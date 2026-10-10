// Copyright The Harmoniq Authors
// SPDX-License-Identifier: Apache-2.0

import type { HostApp } from '@prisma/client';
import type { TenantTx } from '@harmoniq/db';
import { ValidationError } from '@harmoniq/core/dist/errors/AppError';
import {
  DependencyConflict,
  DependencySource,
  HOST_SOURCE,
  dependencyMatrix,
  findDependencyConflicts,
  removedExposes,
} from '@harmoniq/core/dist/manifest/dependencies';

const asRecord = (value: unknown) => (value ?? undefined) as Record<string, string> | undefined;

export interface GateResult {
  dependencyConflicts: DependencyConflict[];
  removedExposes: string[];
  /** Whether the change would be refused without `force`. */
  blocking: boolean;
}

/** The host's shared dependencies, as a matrix source. */
const hostSource = (hostApp: Pick<HostApp, 'sharedDependencies'>): DependencySource[] =>
  hostApp.sharedDependencies
    ? [{ name: HOST_SOURCE, dependencies: asRecord(hostApp.sharedDependencies) }]
    : [];

/**
 * DEP-02 and the exposes contract for one module version entering an environment: its
 * ranges against every other active module and the host's shared dependencies, and the
 * exposes the current active version has that it drops.
 */
export async function checkGate(
  tx: TenantTx,
  input: {
    hostApp: Pick<HostApp, 'sharedDependencies' | 'strictExposes'>;
    environmentId: string;
    module: { id: string; slug: string };
    dependencies?: Record<string, string> | null;
    exposes?: Record<string, string> | null;
  }
): Promise<GateResult> {
  const active = await tx.moduleVersion.findMany({
    where: { environmentId: input.environmentId, status: 'active', deletedAt: null },
    include: { remoteModule: { select: { slug: true } } },
  });
  const others = active
    .filter((v) => v.remoteModuleId !== input.module.id)
    .map((v) => ({ name: v.remoteModule.slug, dependencies: asRecord(v.dependencies) }));
  const conflicts = findDependencyConflicts(
    { name: input.module.slug, dependencies: input.dependencies },
    [...others, ...hostSource(input.hostApp)]
  );
  const current = active.find((v) => v.remoteModuleId === input.module.id);
  const removed = removedExposes(asRecord(current?.exposes), input.exposes);
  return {
    dependencyConflicts: conflicts,
    removedExposes: removed,
    blocking: conflicts.length > 0 || (input.hostApp.strictExposes && removed.length > 0),
  };
}

/** Throws 422 for a blocking result unless forced (DEP-02/03). */
export function enforceGate(gate: GateResult, force: boolean | undefined) {
  if (!gate.blocking || force) return;
  const reasons = [
    ...gate.dependencyConflicts.map(
      (c) =>
        `${c.package}: ${c.between.map((b) => `${b.range} (${b.source})`).join(' vs ')}${c.reason === 'invalid_range' ? ' is not a valid range' : ''}`
    ),
    ...(gate.removedExposes.length ? [`removes exposes ${gate.removedExposes.join(', ')}`] : []),
  ];
  throw new ValidationError(
    `Blocked by the dependency gate: ${reasons.join('; ')}. Use force to deploy anyway.`,
    { dependencyConflicts: gate.dependencyConflicts, removedExposes: gate.removedExposes }
  );
}

/**
 * DEP-04: the environment's active modules against the host's shared deps. Canaries are
 * left out: a user gets a module's canary or its active version, never both.
 */
export async function environmentMatrix(
  tx: TenantTx,
  hostApp: Pick<HostApp, 'sharedDependencies'>,
  environmentId: string
) {
  const versions = await tx.moduleVersion.findMany({
    where: { environmentId, status: 'active', deletedAt: null },
    include: { remoteModule: { select: { slug: true } } },
    orderBy: { remoteModule: { slug: 'asc' } },
  });
  const sources: DependencySource[] = [
    ...hostSource(hostApp),
    ...versions.map((v) => ({
      name: v.remoteModule.slug,
      dependencies: asRecord(v.dependencies),
    })),
  ];
  return dependencyMatrix(sources);
}
