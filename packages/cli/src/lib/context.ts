import { Command } from 'commander';
import { CliError, EXIT } from './errors';
import { readConfig } from './config';
import { ApiClient } from './api';

export const DEFAULT_REGISTRY_URL = 'http://localhost:4000';

export interface Context {
  registryUrl: string;
  apiKey?: string;
  workspace?: string;
  json: boolean;
  profile: string;
  /** APR-13: change ticket sent with changes that may need approval. */
  changeTicket?: string;
  /** Wait for approval when a change becomes a pending request. */
  wait: boolean;
}

/** Precedence: flag > environment variable > saved profile > default. */
export async function resolveContext(command: Command): Promise<Context> {
  const root = command.optsWithGlobals<{
    registryUrl?: string;
    apiKey?: string;
    workspace?: string;
    json?: boolean;
    profile?: string;
    changeTicket?: string;
    wait?: boolean;
  }>();
  const profileName = root.profile ?? process.env.HARMONIQ_PROFILE ?? 'default';
  const profile = (await readConfig()).profiles[profileName];

  return {
    registryUrl: (
      root.registryUrl ??
      process.env.HARMONIQ_REGISTRY_URL ??
      profile?.registryUrl ??
      DEFAULT_REGISTRY_URL
    ).replace(/\/$/, ''),
    apiKey: root.apiKey ?? process.env.HARMONIQ_API_KEY ?? profile?.apiKey,
    workspace: root.workspace ?? process.env.HARMONIQ_WORKSPACE ?? profile?.workspace,
    json: !!root.json,
    profile: profileName,
    changeTicket: root.changeTicket ?? process.env.HARMONIQ_CHANGE_TICKET,
    wait: !!root.wait,
  };
}

export function requireWorkspace(ctx: Context): string {
  if (!ctx.workspace) {
    throw new CliError(
      'No workspace: pass --workspace, set HARMONIQ_WORKSPACE or run `harmoniq login`',
      EXIT.validation
    );
  }
  return ctx.workspace;
}

export function authedClient(ctx: Context): ApiClient {
  if (!ctx.apiKey) {
    throw new CliError(
      'No API key: pass --api-key, set HARMONIQ_API_KEY or run `harmoniq login`',
      EXIT.auth
    );
  }
  return new ApiClient(
    ctx.registryUrl,
    ctx.apiKey,
    ctx.changeTicket ? { 'X-Harmoniq-Change-Ticket': ctx.changeTicket } : {}
  );
}
