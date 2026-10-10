// Copyright The Harmoniq Authors
// SPDX-License-Identifier: Apache-2.0

import { CliError } from './errors';

interface Conflict {
  package: string;
  between: Array<{ source: string; range: string }>;
  reason: string;
}

/** DEP-05: dependency conflicts and removed exposes, one stderr line each. */
export function printGate(details: unknown) {
  const d = (details ?? {}) as { dependencyConflicts?: Conflict[]; removedExposes?: string[] };
  for (const c of d.dependencyConflicts ?? []) {
    const ranges = c.between.map((b) => `${b.range} (${b.source})`).join(' vs ');
    console.error(
      c.reason === 'invalid_range'
        ? `conflict: ${c.package} ${ranges} is not a valid semver range`
        : `conflict: ${c.package} ${ranges} — no version satisfies both`
    );
  }
  for (const path of d.removedExposes ?? []) {
    console.error(`warning: removes exposed module ${path} (hosts importing it will break)`);
  }
}

/** Prints gate details from a failed call before passing the error on. */
export async function withGateReport<T>(call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (err) {
    if (err instanceof CliError) printGate(err.details);
    throw err;
  }
}
