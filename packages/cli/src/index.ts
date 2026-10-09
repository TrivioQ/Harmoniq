#!/usr/bin/env node

import { Command } from 'commander';
import { loginCommand } from './commands/login';
import { whoamiCommand } from './commands/whoami';
import { deployCommand } from './commands/deploy';
import { promoteCommand } from './commands/promote';
import { canaryCommand } from './commands/canary';
import { rollbackCommand } from './commands/rollback';
import { validateCommand } from './commands/validate';
import { manifestCommand } from './commands/manifest';
import { doctorCommand } from './commands/doctor';
import { CliError, EXIT } from './lib/errors';

export function buildProgram() {
  return new Command()
    .name('harmoniq')
    .description('Harmoniq CLI for CI/CD deployments and validation')
    .version('1.0.0')
    .option('--json', 'Machine-readable JSON output')
    .option('--registry-url <url>', 'Registry URL (env HARMONIQ_REGISTRY_URL)')
    .option('--api-key <key>', 'API key (env HARMONIQ_API_KEY)')
    .option('--workspace <slug>', 'Workspace slug (env HARMONIQ_WORKSPACE)')
    .option('--profile <name>', 'Saved profile (env HARMONIQ_PROFILE)', undefined)
    .addCommand(loginCommand)
    .addCommand(whoamiCommand)
    .addCommand(deployCommand)
    .addCommand(promoteCommand)
    .addCommand(rollbackCommand)
    .addCommand(canaryCommand)
    .addCommand(validateCommand)
    .addCommand(manifestCommand)
    .addCommand(doctorCommand);
}

/**
 * Subcommands are module-level singletons and commander keeps parsed option values on
 * them, so a second `run()` in one process would inherit options from the first.
 */
function resetOptions(command: Command) {
  for (const option of command.options) {
    command.setOptionValueWithSource(option.attributeName(), option.defaultValue, 'default');
  }
  command.commands.forEach(resetOptions);
}

/** Runs the CLI and returns the exit code (see EXIT) instead of exiting, for tests. */
export async function run(argv: string[]): Promise<number> {
  process.exitCode = undefined;
  try {
    const program = buildProgram();
    resetOptions(program);
    await program.parseAsync(argv);
    return Number(process.exitCode ?? EXIT.ok);
  } catch (err) {
    if (err instanceof CliError) {
      console.error(`Error: ${err.message}`);
      if (err.details) console.error(JSON.stringify(err.details, null, 2));
      return err.exitCode;
    }
    console.error(err);
    return EXIT.generic;
  }
}

// Executed as a binary (not imported by tests).
if (process.env.VITEST === undefined) {
  run(process.argv).then((code) => process.exit(code));
}
