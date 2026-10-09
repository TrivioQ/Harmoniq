import { Command } from 'commander';
import { isValidBundle, validateBundle } from '@harmoniq/core/dist/validation/bundle';
import { authedClient, requireWorkspace, resolveContext } from '../lib/context';
import { CliError, EXIT } from '../lib/errors';
import { resolveIntegrity } from '../lib/integrity';
import { emit, enc } from '../lib/output';
import { collectTarget, parsePercent, parseRollout, parseTargets } from './canary';

const collect = (value: string, previous: string[] = []) => [...previous, value];

export const deployCommand = new Command('deploy')
  .description('Deploy a module version to an environment')
  .requiredOption('--module <module>', 'Module slug or id')
  .requiredOption('--env <environment>', 'Target environment, e.g. staging')
  .requiredOption('--url <url>', 'Public URL of the bundle (remoteEntry.js)')
  .requiredOption('--release <version>', 'Version being deployed, e.g. 1.2.3')
  .option('--integrity <sri>', 'SRI hash, e.g. sha384-…')
  .option('--file <path>', 'Local copy of the bundle; computes --integrity')
  .option('--commit <sha>', 'Commit SHA (defaults to GITHUB_SHA / CI_COMMIT_SHA)')
  .option('--meta <key=value>', 'Metadata entry (repeatable)', collect)
  .option('--validate', 'Check the bundle URL and integrity locally before deploying')
  .option('--dry-run', 'Validate on the registry and show the projected change; deploy nothing')
  .option(
    '--canary <percent>',
    'Deploy as a canary for this share of users (1–99); the active version keeps the rest'
  )
  .option(
    '--target <attribute=values>',
    'With --canary or --rollout: always give the canary to matching users, e.g. plan=beta (repeatable)',
    collectTarget
  )
  .option(
    '--rollout <percents>',
    'Staged canary rollout, e.g. 1,10,50,100: each band runs for --hold, then advances if healthy; 100 promotes'
  )
  .option('--hold <duration>', 'Time per rollout band, e.g. 30m, 2h (default 30m)')
  .option(
    '--max-error-rate <rate>',
    'Rollout gate: abort if the canary error rate exceeds this (0–1)'
  )
  .option(
    '--max-error-delta <rate>',
    'Rollout gate: abort if canary errors exceed stable by this (0–1)'
  )
  .option('--max-p95 <ms>', 'Rollout gate: abort if the canary p95 load time exceeds this')
  .option(
    '--min-samples <n>',
    'Rollout gate: canary loads needed per band before deciding (default 20)'
  )
  .option(
    '--preview-ttl <hours>',
    'Create --env as a preview environment (e.g. pr-123) that expires after this many hours'
  )
  .action(async (opts, command: Command) => {
    const ctx = await resolveContext(command);
    const workspace = requireWorkspace(ctx);
    if (opts.canary !== undefined && opts.rollout !== undefined) {
      throw new CliError('Use either --canary or --rollout', EXIT.validation);
    }
    const targeting = opts.target ? parseTargets(opts.target) : undefined;
    const canary =
      opts.canary !== undefined ? parsePercent(opts.canary, !!targeting?.length) : undefined;
    const rollout = opts.rollout !== undefined ? parseRollout(opts) : undefined;
    const integrity = await resolveIntegrity(opts);

    if (opts.validate) {
      const validation = await validateBundle(opts.url, integrity);
      validation.warnings.forEach((w) => console.error(`warning: ${w}`));
      if (!isValidBundle(validation)) {
        throw new CliError(
          `Bundle failed validation: ${validation.errors.join('; ')}`,
          EXIT.validation,
          validation
        );
      }
    }

    const metadata = Object.fromEntries(
      (opts.meta ?? []).map((pair: string) => {
        const i = pair.indexOf('=');
        if (i < 1) throw new CliError(`--meta must be key=value, got "${pair}"`, EXIT.validation);
        return [pair.slice(0, i), pair.slice(i + 1)];
      })
    );
    const commitSha = opts.commit ?? process.env.GITHUB_SHA ?? process.env.CI_COMMIT_SHA;

    const result = await authedClient(ctx).post<Record<string, unknown>>(
      `/api/workspaces/${enc(workspace)}/modules/${enc(opts.module)}/deploy`,
      {
        environment: opts.env,
        url: opts.url,
        version: opts.release,
        integrity,
        ...(commitSha && { commitSha }),
        ...(Object.keys(metadata).length && { metadata }),
        dryRun: !!opts.dryRun,
        ...(opts.previewTtl && { ephemeral: { ttlHours: Number(opts.previewTtl) } }),
        ...(canary !== undefined && { canary: { trafficPercent: canary, targeting } }),
        ...(rollout && { canary: { rollout, targeting } }),
      }
    );

    if (opts.dryRun) {
      const validation = result.validation as { errors: string[]; warnings: string[] };
      validation.warnings.forEach((w) => console.error(`warning: ${w}`));
      emit(ctx, result, () =>
        validation.errors.length
          ? `Dry run: bundle failed validation: ${validation.errors.join('; ')}`
          : `Dry run OK: ${opts.module} ${opts.release} would be deployed to ${opts.env}${result.frozen ? ' (environment is FROZEN)' : ''}`
      );
      if (validation.errors.length) process.exitCode = EXIT.validation;
      return;
    }

    emit(
      ctx,
      result,
      (rollout
        ? `Deployed ${opts.module} ${opts.release} to ${opts.env} as a staged rollout (${rollout.bands.map((b) => `${b.percent}%`).join(' → ')})`
        : canary !== undefined
          ? `Deployed ${opts.module} ${opts.release} to ${opts.env} as a canary for ${canary}% of users`
          : `Deployed ${opts.module} ${opts.release} to ${opts.env}`) +
        ` (manifest ${result.manifestEtag})` +
        (result.previewUrl ? `\nPreview: ${result.previewUrl}` : '')
    );
  });
