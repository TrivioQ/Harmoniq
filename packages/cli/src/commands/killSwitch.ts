import { Command } from 'commander';
import { authedClient, requireWorkspace, resolveContext } from '../lib/context';
import { emit, enc } from '../lib/output';

type KillSwitchResult = { module: string; environment: string; disabled: boolean };

function killSwitch(disabled: boolean) {
  const command = new Command(disabled ? 'disable' : 'enable')
    .description(
      disabled
        ? 'Kill switch: hosts stop loading the module at their next manifest fetch (works in frozen environments)'
        : 'Turn the kill switch off again'
    )
    .requiredOption('--module <module>', 'Module slug or id')
    .requiredOption('--env <environment>', 'Environment');
  if (disabled)
    command.requiredOption('--reason <text>', 'Why (shown to hosts and in the audit log)');
  return command.action(async (opts, cmd: Command) => {
    const ctx = await resolveContext(cmd);
    const workspace = requireWorkspace(ctx);
    const result = await authedClient(ctx).put<KillSwitchResult>(
      `/api/workspaces/${enc(workspace)}/modules/${enc(opts.module)}/kill-switch`,
      { environment: opts.env, disabled, ...(disabled && { reason: opts.reason }) }
    );
    emit(
      ctx,
      result,
      `${result.module} is ${result.disabled ? 'disabled' : 'enabled'} in ${result.environment}`
    );
  });
}

export const disableCommand = killSwitch(true);
export const enableCommand = killSwitch(false);
