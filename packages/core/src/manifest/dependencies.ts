// Copyright The Harmoniq Authors
// SPDX-License-Identifier: Apache-2.0

import semver from 'semver';

/** A module (or the host app's shared dependencies) and the ranges it declares. */
export interface DependencySource {
  name: string;
  dependencies?: Record<string, string> | null;
}

export interface DependencyConflict {
  package: string;
  /** Pairs of sources whose ranges can't be satisfied by one version. */
  between: Array<{ source: string; range: string }>;
  reason: 'no_common_version' | 'invalid_range';
}

/** Host app shared dependencies appear under this source name. */
export const HOST_SOURCE = '(host)';

const valid = (range: string) => semver.validRange(range, { loose: true }) !== null;

/**
 * DEP-02: conflicts between `candidate` and the other sources (active modules, the host's
 * shared dependencies). Conflicts among the others are not reported: a deploy is only
 * blocked by what it changes. Two ranges conflict when no version satisfies both.
 */
export function findDependencyConflicts(
  candidate: DependencySource,
  others: DependencySource[]
): DependencyConflict[] {
  const conflicts: DependencyConflict[] = [];
  for (const [pkg, range] of Object.entries(candidate.dependencies ?? {})) {
    if (!valid(range)) {
      conflicts.push({
        package: pkg,
        between: [{ source: candidate.name, range }],
        reason: 'invalid_range',
      });
      continue;
    }
    for (const other of others) {
      if (other.name === candidate.name) continue;
      const otherRange = other.dependencies?.[pkg];
      if (!otherRange || !valid(otherRange)) continue;
      if (!semver.intersects(range, otherRange, { loose: true })) {
        conflicts.push({
          package: pkg,
          between: [
            { source: candidate.name, range },
            { source: other.name, range: otherRange },
          ],
          reason: 'no_common_version',
        });
      }
    }
  }
  return conflicts;
}

/** DEP-04: every package with the range each source declares, and every conflict. */
export function dependencyMatrix(sources: DependencySource[]) {
  const packages = [...new Set(sources.flatMap((s) => Object.keys(s.dependencies ?? {})))].sort();
  const seen = new Set<string>();
  const conflicts: DependencyConflict[] = [];
  for (const source of sources) {
    for (const conflict of findDependencyConflicts(source, sources)) {
      // Each pair once, whichever side found it.
      const key = `${conflict.package}:${conflict.between
        .map((b) => b.source)
        .sort()
        .join('|')}`;
      if (!seen.has(key)) {
        seen.add(key);
        conflicts.push(conflict);
      }
    }
  }
  return {
    packages,
    sources: sources.map((s) => ({ name: s.name, dependencies: s.dependencies ?? {} })),
    conflicts,
  };
}

/** Exposes in `previous` that `next` no longer has (a breaking change for hosts). */
export function removedExposes(
  previous: Record<string, string> | null | undefined,
  next: Record<string, string> | null | undefined
): string[] {
  if (!previous || !next) return [];
  return Object.keys(previous).filter((path) => !(path in next));
}
