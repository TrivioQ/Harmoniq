import { Command } from 'commander';
import { authedClient, requireWorkspace, resolveContext } from '../lib/context';
import { CliError, EXIT } from '../lib/errors';
import { emit, enc } from '../lib/output';

type CanaryResult = { version: string; status: string; trafficPercent: number | null };

export function parsePercent(value: string): number {
  const percent = Number(value);
  if (!Number.isInteger(percent) || percent < 1 || percent > 99) {
    throw new CliError(
      `Canary traffic must be a whole number from 1 to 99, got "${value}"`,
      EXIT.validation
    );
  }
  return percent;
}

const target = (cmd: Command) =>
  cmd
    .requiredOption('--module <module>', 'Module slug or id')
    .requiredOption('--env <environment>', 'Environment');

const path = (workspace: string, module: string, action = '') =>
  `/api/workspaces/${enc(workspace)}/modules/${enc(module)}/canary${action}`;

const setTraffic = target(new Command('set-traffic'))
  .description('Change the share of users on the canary (1–99), e.g. to ramp it up')
  .argument('<percent>', 'Traffic percentage')
  .option('--version-id <id>', 'Make this earlier version the canary instead')
  .action(async (percent: string, opts, command: Command) => {
    const ctx = await resolveContext(command);
    const workspace = requireWorkspace(ctx);
    const result = await authedClient(ctx).put<CanaryResult>(path(workspace, opts.module), {
      environment: opts.env,
      trafficPercent: parsePercent(percent),
      ...(opts.versionId && { versionId: opts.versionId }),
    });
    emit(
      ctx,
      result,
      `Canary ${opts.module} ${result.version} in ${opts.env}: ${result.trafficPercent}% of users`
    );
  });

const promote = target(new Command('promote'))
  .description('Make the canary the active version for everyone')
  .option('--reason <text>', 'Recorded in the audit log')
  .action(async (opts, command: Command) => {
    const ctx = await resolveContext(command);
    const workspace = requireWorkspace(ctx);
    const result = await authedClient(ctx).post<CanaryResult>(
      path(workspace, opts.module, '/promote'),
      { environment: opts.env, ...(opts.reason && { reason: opts.reason }) }
    );
    emit(ctx, result, `Promoted canary ${opts.module} ${result.version} in ${opts.env}`);
  });

const abort = target(new Command('abort'))
  .description('Stop the canary; everyone goes back to the active version')
  .option('--reason <text>', 'Recorded in the audit log')
  .action(async (opts, command: Command) => {
    const ctx = await resolveContext(command);
    const workspace = requireWorkspace(ctx);
    const result = await authedClient(ctx).post<CanaryResult>(
      path(workspace, opts.module, '/abort'),
      { environment: opts.env, ...(opts.reason && { reason: opts.reason }) }
    );
    emit(ctx, result, `Aborted canary ${opts.module} ${result.version} in ${opts.env}`);
  });

export const canaryCommand = new Command('canary')
  .description('Manage canary releases (start one with `deploy --canary <percent>`)')
  .addCommand(setTraffic)
  .addCommand(promote)
  .addCommand(abort);
