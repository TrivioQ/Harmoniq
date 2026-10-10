// Copyright The Harmoniq Authors
// SPDX-License-Identifier: Apache-2.0

import { Command } from 'commander';
import { writeFile } from 'fs/promises';
import { ApiClient } from '../lib/api';
import { requireWorkspace, resolveContext } from '../lib/context';
import { emit, enc } from '../lib/output';

// Manifests are public: no API key needed.
async function fetchManifest(command: Command, opts: { host?: string; env: string }) {
  const ctx = await resolveContext(command);
  const workspace = requireWorkspace(ctx);
  const path = opts.host
    ? `/api/manifest/${enc(workspace)}/${enc(opts.host)}/${enc(opts.env)}`
    : `/api/manifest/${enc(workspace)}/${enc(opts.env)}`;
  return { ctx, manifest: await new ApiClient(ctx.registryUrl).get<Record<string, unknown>>(path) };
}

const getCommand = new Command('get')
  .description('Print the current manifest')
  .requiredOption('--env <environment>', 'Environment')
  .option('--host <hostApp>', 'Host app slug (default: the workspace default host app)')
  .action(async (opts, command: Command) => {
    const { manifest } = await fetchManifest(command, opts);
    console.log(JSON.stringify(manifest, null, 2));
  });

const pullCommand = new Command('pull')
  .description('Save the current manifest to a file, e.g. as a build-time fallback')
  .requiredOption('--env <environment>', 'Environment')
  .requiredOption('--out <file>', 'Output path')
  .option('--host <hostApp>', 'Host app slug (default: the workspace default host app)')
  .action(async (opts, command: Command) => {
    const { ctx, manifest } = await fetchManifest(command, opts);
    await writeFile(opts.out, JSON.stringify(manifest, null, 2) + '\n');
    emit(
      ctx,
      { out: opts.out, etag: manifest.etag },
      `Saved manifest (${manifest.etag}) to ${opts.out}`
    );
  });

export const manifestCommand = new Command('manifest')
  .description('Read manifests')
  .addCommand(getCommand)
  .addCommand(pullCommand);
