import { Command } from 'commander';
import { createInterface } from 'readline/promises';
import { ApiClient } from '../lib/api';
import { saveProfile, configPath } from '../lib/config';
import { requireWorkspace, resolveContext } from '../lib/context';
import { CliError, EXIT } from '../lib/errors';
import { emit, enc } from '../lib/output';

async function prompt(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    return (await rl.question(question)).trim();
  } finally {
    rl.close();
  }
}

export const loginCommand = new Command('login')
  .description('Save an API key for a workspace (verified against the registry)')
  .action(async (_opts, command: Command) => {
    const ctx = await resolveContext(command);
    const workspace = ctx.workspace ?? (await prompt('Workspace slug: '));
    const apiKey = ctx.apiKey ?? (await prompt('API key (hq_…): '));
    if (!apiKey.startsWith('hq_')) throw new CliError('API keys start with hq_', EXIT.validation);

    const ws = await new ApiClient(ctx.registryUrl, apiKey).get<{ name: string }>(
      `/api/workspaces/${enc(requireWorkspace({ ...ctx, workspace }))}`
    );
    await saveProfile(ctx.profile, { registryUrl: ctx.registryUrl, apiKey, workspace });
    emit(
      ctx,
      { profile: ctx.profile, workspace, registryUrl: ctx.registryUrl },
      `Logged in to "${ws.name}" (${workspace}) on ${ctx.registryUrl}. Saved profile "${ctx.profile}" to ${configPath()}`
    );
  });
