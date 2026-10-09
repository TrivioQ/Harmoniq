import { Command } from 'commander';
import { authedClient, requireWorkspace, resolveContext } from '../lib/context';
import { emit, enc } from '../lib/output';
import { AT_OPTION, scheduleIfRequested } from '../lib/schedule';

export const promoteCommand = new Command('promote')
  .description('Promote the exact artifact running in one environment to another')
  .requiredOption('--module <module>', 'Module slug or id')
  .requiredOption('--from <environment>', 'Source environment, e.g. staging')
  .requiredOption('--to <environment>', 'Target environment, e.g. production')
  .option('--version-id <id>', 'Promote this version instead of the active one')
  .option(...AT_OPTION)
  .action(async (opts, command: Command) => {
    const ctx = await resolveContext(command);
    const workspace = requireWorkspace(ctx);
    const request = {
      fromEnvironment: opts.from,
      toEnvironment: opts.to,
      ...(opts.versionId && { versionId: opts.versionId }),
    };
    const op = { type: 'promote', module: opts.module, request };
    if (await scheduleIfRequested(ctx, workspace, opts.at, op)) return;
    const result = await authedClient(ctx).post<{ version: string }>(
      `/api/workspaces/${enc(workspace)}/modules/${enc(opts.module)}/promote`,
      request
    );
    emit(ctx, result, `Promoted ${opts.module} ${result.version} from ${opts.from} to ${opts.to}`);
  });
