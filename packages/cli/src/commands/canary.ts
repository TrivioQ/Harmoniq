import { Command } from 'commander';
import { authedClient, requireWorkspace, resolveContext } from '../lib/context';
import { CliError, EXIT } from '../lib/errors';
import { emit, enc } from '../lib/output';

type CanaryResult = { version: string; status: string; trafficPercent: number | null };

/** 1–99, or 0 when targeting rules decide who gets the canary. */
export function parsePercent(value: string, allowZero = false): number {
  const percent = Number(value);
  if (!Number.isInteger(percent) || percent < (allowZero ? 0 : 1) || percent > 99) {
    throw new CliError(
      `Canary traffic must be a whole number from ${allowZero ? 0 : 1} to 99, got "${value}"`,
      EXIT.validation
    );
  }
  return percent;
}

export const collectTarget = (value: string, previous: string[] = []) => [...previous, value];

/** `--target plan=beta,internal --target userId=qa-1` → targeting rules. */
export function parseTargets(targets: string[] = []) {
  return targets.map((target) => {
    const i = target.indexOf('=');
    const values = target
      .slice(i + 1)
      .split(',')
      .map((v) => v.trim())
      .filter(Boolean);
    if (i < 1 || !values.length) {
      throw new CliError(
        `--target must be attribute=value[,value…], got "${target}"`,
        EXIT.validation
      );
    }
    return { attribute: target.slice(0, i), values };
  });
}

/** `30m`, `2h`, `1d` or plain minutes. */
export function parseMinutes(value: string): number {
  const match = /^(\d+)\s*(m|h|d)?$/.exec(value.trim());
  if (!match)
    throw new CliError(`Expected a duration like 30m, 2h or 1d, got "${value}"`, EXIT.validation);
  return Number(match[1]) * ({ m: 1, h: 60, d: 1440 }[match[2] as 'm' | 'h' | 'd'] ?? 1);
}

/** `--rollout 1,10,50,100 --hold 30m` → bands; the last band must be 100. */
export function parseRollout(opts: {
  rollout: string;
  hold?: string;
  maxErrorRate?: string;
  maxErrorDelta?: string;
  maxP95?: string;
  minSamples?: string;
}) {
  const percents = opts.rollout.split(',').map((p) => Number(p.trim()));
  if (
    percents.length < 2 ||
    percents.some(
      (p, i) => !Number.isInteger(p) || p < 1 || p > 100 || (i && p <= percents[i - 1])
    ) ||
    percents[percents.length - 1] !== 100
  ) {
    throw new CliError(
      `--rollout needs increasing percentages ending at 100, e.g. 1,10,50,100 (got "${opts.rollout}")`,
      EXIT.validation
    );
  }
  const holdMinutes = parseMinutes(opts.hold ?? '30m');
  const num = (v?: string) => (v === undefined ? undefined : Number(v));
  return {
    bands: percents.map((percent) => ({ percent, holdMinutes: percent === 100 ? 0 : holdMinutes })),
    gate: {
      ...(opts.maxErrorRate !== undefined && { maxErrorRate: num(opts.maxErrorRate) }),
      ...(opts.maxErrorDelta !== undefined && { maxErrorRateDelta: num(opts.maxErrorDelta) }),
      ...(opts.maxP95 !== undefined && { maxP95Ms: num(opts.maxP95) }),
      ...(opts.minSamples !== undefined && { minSamples: num(opts.minSamples) }),
    },
  };
}

const target = (cmd: Command) =>
  cmd
    .requiredOption('--module <module>', 'Module slug or id')
    .requiredOption('--env <environment>', 'Environment');

const path = (workspace: string, module: string, action = '') =>
  `/api/workspaces/${enc(workspace)}/modules/${enc(module)}/canary${action}`;

const setTraffic = target(new Command('set-traffic'))
  .description('Change the share of users on the canary (1–99), e.g. to ramp it up')
  .argument('<percent>', 'Traffic percentage (0 with --target: only matching users)')
  .option('--version-id <id>', 'Make this earlier version the canary instead')
  .option(
    '--target <attribute=values>',
    'Always give the canary to matching users, e.g. plan=beta or userId=u1,u2 (repeatable; replaces existing rules)',
    collectTarget
  )
  .action(async (percent: string, opts, command: Command) => {
    const ctx = await resolveContext(command);
    const workspace = requireWorkspace(ctx);
    const targeting = opts.target ? parseTargets(opts.target) : undefined;
    const result = await authedClient(ctx).put<CanaryResult>(path(workspace, opts.module), {
      environment: opts.env,
      trafficPercent: parsePercent(percent, !!targeting?.length),
      ...(opts.versionId && { versionId: opts.versionId }),
      ...(targeting && { targeting }),
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

const advance = target(new Command('advance'))
  .description('Move a staged rollout to its next band now, without waiting for its gate')
  .action(async (opts, command: Command) => {
    const ctx = await resolveContext(command);
    const workspace = requireWorkspace(ctx);
    const result = await authedClient(ctx).post<CanaryResult>(
      path(workspace, opts.module, '/advance'),
      { environment: opts.env }
    );
    emit(
      ctx,
      result,
      result.status === 'active'
        ? `Rollout of ${opts.module} ${result.version} in ${opts.env} complete: promoted`
        : `Rollout of ${opts.module} ${result.version} in ${opts.env}: ${result.trafficPercent}% of users`
    );
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
  .addCommand(advance)
  .addCommand(abort);
