// Copyright The Harmoniq Authors
// SPDX-License-Identifier: Apache-2.0

import { Command } from 'commander';
import { authedClient, requireWorkspace, resolveContext } from '../lib/context';
import { emit, enc } from '../lib/output';

export const whoamiCommand = new Command('whoami')
  .description('Show which registry and workspace the CLI is using, and verify the key')
  .action(async (_opts, command: Command) => {
    const ctx = await resolveContext(command);
    const workspace = requireWorkspace(ctx);
    const ws = await authedClient(ctx).get<{ name: string; hostApps: { slug: string }[] }>(
      `/api/workspaces/${enc(workspace)}`
    );
    const info = {
      registryUrl: ctx.registryUrl,
      workspace,
      workspaceName: ws.name,
      profile: ctx.profile,
      keyPrefix: ctx.apiKey!.slice(0, 11),
      hostApps: ws.hostApps.map((h) => h.slug),
    };
    emit(
      ctx,
      info,
      `${info.keyPrefix}… → workspace "${ws.name}" (${workspace}) on ${ctx.registryUrl}`
    );
  });
