// Copyright The Harmoniq Authors
// SPDX-License-Identifier: Apache-2.0

import { Command } from 'commander';
import { authedClient, requireWorkspace, resolveContext } from '../lib/context';
import { emit, enc } from '../lib/output';

interface Operation {
  id: string;
  type: string;
  module: string | null;
  environment: string | null;
  runAt: string;
  status: string;
  error: string | null;
}

const list = new Command('list')
  .description('Scheduled operations, newest first (create them with --at on deploy, promote, …)')
  .option('--status <status>', 'pending, running, done, failed or cancelled')
  .action(async (opts, command: Command) => {
    const ctx = await resolveContext(command);
    const workspace = requireWorkspace(ctx);
    const query = opts.status ? `?status=${enc(opts.status)}` : '';
    const result = await authedClient(ctx).get<{ operations: Operation[] }>(
      `/api/workspaces/${enc(workspace)}/scheduled-operations${query}`
    );
    emit(ctx, result, () =>
      result.operations.length
        ? result.operations
            .map(
              (o) =>
                `${o.id}  ${o.runAt}  ${o.status.padEnd(9)}  ${o.type} ${o.module ?? ''}${o.environment ? ` → ${o.environment}` : ''}${o.error ? `  (${o.error})` : ''}`
            )
            .join('\n')
        : 'No scheduled operations'
    );
  });

const cancel = new Command('cancel')
  .description('Cancel a pending scheduled operation')
  .argument('<id>', 'Operation id')
  .action(async (id: string, _opts, command: Command) => {
    const ctx = await resolveContext(command);
    const workspace = requireWorkspace(ctx);
    const result = await authedClient(ctx).request<Operation>(
      'DELETE',
      `/api/workspaces/${enc(workspace)}/scheduled-operations/${enc(id)}`
    );
    emit(ctx, result, `Cancelled ${result.type} of ${result.module} (was due ${result.runAt})`);
  });

export const scheduleCommand = new Command('schedule')
  .description('Scheduled operations')
  .addCommand(list)
  .addCommand(cancel);
