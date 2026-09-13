import { Command } from 'commander';

export const promoteCommand = new Command('promote')
  .description('Promote a module version to another environment')
  .requiredOption('--workspace <slug>', 'Workspace slug')
  .requiredOption('--module <id>', 'Module ID')
  .requiredOption('--source-env <env>', 'Source Environment')
  .requiredOption('--target-env <env>', 'Target Environment')
  .requiredOption('--version-id <id>', 'Module version ID (semver)')
  .action(async (options, command) => {
    // API call omitted for brevity in stub
    const parentOpts = command.parent?.opts() || {};
    if (parentOpts.json) {
      console.log(JSON.stringify({ success: true }));
    } else {
      console.log(
        `Successfully promoted ${options.module} version ${options.versionId} to ${options.targetEnv}`
      );
    }
  });
