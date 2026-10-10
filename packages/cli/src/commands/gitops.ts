// Copyright The Harmoniq Authors
// SPDX-License-Identifier: Apache-2.0

import { Command } from 'commander';
import { readFile, writeFile } from 'fs/promises';
import { parse, stringify } from 'yaml';
import { authedClient, requireWorkspace, resolveContext, Context } from '../lib/context';
import { CliError, EXIT } from '../lib/errors';
import { emit, enc } from '../lib/output';

// IaC-09..12: the workspace's declared state in harmoniq.yaml.

interface Change {
  action: 'create' | 'update' | 'delete';
  type: string;
  key: string;
  fields?: string[];
  blocked?: string;
}
interface ApplyResult {
  dryRun: boolean;
  changes: Change[];
  summary: { create: number; update: number; delete: number; blocked: number };
  secrets?: Record<string, string>;
}

/** `${NAME}` in string values comes from the environment: secrets stay out of the file. */
export function substituteEnv(value: unknown, missing: Set<string>): unknown {
  if (typeof value === 'string') {
    return value.replace(/\$\{([A-Z0-9_]+)\}/gi, (_, name: string) => {
      const found = process.env[name];
      if (found === undefined) missing.add(name);
      return found ?? '';
    });
  }
  if (Array.isArray(value)) return value.map((v) => substituteEnv(v, missing));
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, substituteEnv(v, missing)])
    );
  }
  return value;
}

async function loadConfig(file: string) {
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch {
    throw new CliError(`Cannot read ${file}`, EXIT.validation);
  }
  let config: unknown;
  try {
    config = parse(text);
  } catch (err) {
    throw new CliError(`${file} is not valid YAML: ${(err as Error).message}`, EXIT.validation);
  }
  const missing = new Set<string>();
  const resolved = substituteEnv(config, missing);
  if (missing.size) {
    throw new CliError(
      `Environment variables used in ${file} are not set: ${[...missing].join(', ')}`,
      EXIT.validation
    );
  }
  return resolved;
}

const SIGN = { create: '+', update: '~', delete: '-' } as const;

function describe(result: ApplyResult): string {
  if (!result.changes.length) return 'No changes. The workspace matches the file.';
  const lines = result.changes.map((c) => {
    const fields = c.fields?.length ? ` (${c.fields.join(', ')})` : '';
    const blocked = c.blocked ? `  [blocked: ${c.blocked}]` : '';
    return `  ${SIGN[c.action]} ${c.type} ${c.key}${fields}${blocked}`;
  });
  const { create, update, delete: del, blocked } = result.summary;
  const verb = result.dryRun ? 'Plan' : 'Applied';
  lines.push(
    '',
    `${verb}: ${create} to create, ${update} to update, ${del} to delete${blocked ? `, ${blocked} blocked` : ''}.`
  );
  for (const [url, secret] of Object.entries(result.secrets ?? {})) {
    lines.push(`Webhook ${url} signing secret (shown once): ${secret}`);
  }
  return lines.join('\n');
}

async function run(
  command: Command,
  opts: { file: string; prune?: boolean },
  dryRun: boolean
): Promise<{ ctx: Context; result: ApplyResult }> {
  const ctx = await resolveContext(command);
  const config = await loadConfig(opts.file);
  const fileWorkspace = (config as { workspace?: string } | null)?.workspace;
  const workspace = ctx.workspace ?? fileWorkspace;
  if (!workspace) requireWorkspace(ctx);
  const result = await authedClient(ctx).post<ApplyResult>(
    `/api/workspaces/${enc(workspace!)}/apply`,
    { config, dryRun, prune: !!opts.prune }
  );
  return { ctx, result };
}

const FILE_OPTION = ['-f, --file <path>', 'The declared state', 'harmoniq.yaml'] as const;
const PRUNE_OPTION = [
  '--prune',
  'Delete what the file does not declare (in the sections it has)',
] as const;

export const planCommand = new Command('plan')
  .description('Show what applying harmoniq.yaml would change, without changing anything')
  .option(...FILE_OPTION)
  .option(...PRUNE_OPTION)
  .option('--detailed-exitcode', 'Exit with 7 when there are changes (drift checks in CI)')
  .action(async (opts, command: Command) => {
    const { ctx, result } = await run(command, opts, true);
    emit(ctx, result, () => describe(result));
    if (opts.detailedExitcode && result.changes.some((c) => !c.blocked)) {
      process.exitCode = EXIT.changes;
    }
  });

export const applyCommand = new Command('apply')
  .description('Make the workspace match harmoniq.yaml')
  .option(...FILE_OPTION)
  .option(...PRUNE_OPTION)
  .action(async (opts, command: Command) => {
    const { ctx, result } = await run(command, opts, false);
    emit(ctx, result, () => describe(result));
  });

export const importCommand = new Command('import')
  .description('Write the workspace as it is now to harmoniq.yaml (to start using GitOps)')
  .option('-o, --out <path>', 'Output path', 'harmoniq.yaml')
  .option('--force', 'Overwrite an existing file')
  .action(async (opts, command: Command) => {
    const ctx = await resolveContext(command);
    const workspace = requireWorkspace(ctx);
    const config = await authedClient(ctx).get<object>(`/api/workspaces/${enc(workspace)}/config`);
    const header =
      '# Harmoniq workspace configuration. Plan with `harmoniq plan`, apply with `harmoniq apply`.\n' +
      '# Secrets: reference environment variables, e.g. secret: ${HARMONIQ_WEBHOOK_SECRET}\n';
    try {
      await writeFile(opts.out, header + stringify(config), { flag: opts.force ? 'w' : 'wx' });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
        throw new CliError(`${opts.out} exists; pass --force to overwrite it`, EXIT.conflict);
      }
      throw err;
    }
    emit(ctx, { out: opts.out }, `Wrote ${workspace} to ${opts.out}`);
  });
