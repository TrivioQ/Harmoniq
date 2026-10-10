// Copyright The Harmoniq Authors
// SPDX-License-Identifier: Apache-2.0

import { authedClient } from './context';
import type { Context } from './context';
import { CliError, EXIT } from './errors';
import { emit, enc } from './output';

/** `--at` accepts an ISO time (`2026-10-12T09:00:00Z`) or an offset (`+30m`, `+2h`, `+1d`). */
export function parseAt(value: string, now = Date.now()): string {
  const offset = /^\+(\d+)\s*(m|h|d)$/.exec(value.trim());
  if (offset) {
    const minutes = Number(offset[1]) * { m: 1, h: 60, d: 1440 }[offset[2] as 'm' | 'h' | 'd'];
    return new Date(now + minutes * 60_000).toISOString();
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime()) || !/\d{4}-\d{2}-\d{2}T/.test(value)) {
    throw new CliError(
      `--at must be an ISO time like 2026-10-12T09:00:00Z or an offset like +30m, got "${value}"`,
      EXIT.validation
    );
  }
  return date.toISOString();
}

export const AT_OPTION = [
  '--at <time>',
  'Schedule instead of running now: ISO time (2026-10-12T09:00:00Z) or offset (+30m, +2h, +1d)',
] as const;

/**
 * With `--at`, registers the operation to run later (as you, with your permissions checked
 * again then) and returns true; otherwise returns false and the command runs it now.
 */
export async function scheduleIfRequested(
  ctx: Context,
  workspace: string,
  at: string | undefined,
  operation: { type: string; module: string; request: Record<string, unknown> }
): Promise<boolean> {
  if (!at) return false;
  const runAt = parseAt(at);
  const result = await authedClient(ctx).post<{ id: string; runAt: string }>(
    `/api/workspaces/${enc(workspace)}/scheduled-operations`,
    { runAt, operation }
  );
  emit(
    ctx,
    result,
    `Scheduled ${operation.type.replace('_', ' ')} of ${operation.module} for ${result.runAt} (id ${result.id}; cancel with \`harmoniq schedule cancel ${result.id}\`)`
  );
  return true;
}
