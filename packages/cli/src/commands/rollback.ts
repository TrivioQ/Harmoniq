import { Command } from 'commander';
import { authedClient, requireWorkspace, resolveContext } from '../lib/context';
import { CliError, EXIT } from '../lib/errors';
import { emit, enc } from '../lib/output';
import { AT_OPTION, scheduleIfRequested } from '../lib/schedule';

export const rollbackCommand = new Command('rollback')
  .description('Roll a module back to an earlier version (default: the previous one)')
  .requiredOption('--module <module>', 'Module slug or id')
  .requiredOption('--env <environment>', 'Environment')
  .option('--to <version>', 'Version string to roll back to, e.g. 1.2.2')
  .option('--version-id <id>', 'Exact version record id')
  .option(...AT_OPTION)
  .action(async (opts, command: Command) => {
    const ctx = await resolveContext(command);
    const workspace = requireWorkspace(ctx);
    if (opts.to && opts.versionId) {
      throw new CliError('Use either --to or --version-id', EXIT.validation);
    }
    const target = opts.versionId
      ? { versionId: opts.versionId }
      : opts.to
        ? { version: opts.to }
        : { previous: true };

    const request = { environment: opts.env, ...target };
    const op = { type: 'rollback', module: opts.module, request };
    if (await scheduleIfRequested(ctx, workspace, opts.at, op)) return;
    const result = await authedClient(ctx).post<{ version: string; manifestEtag: string }>(
      `/api/workspaces/${enc(workspace)}/modules/${enc(opts.module)}/rollback`,
      request
    );
    emit(ctx, result, `Rolled back ${opts.module} in ${opts.env} to ${result.version}`);
  });
