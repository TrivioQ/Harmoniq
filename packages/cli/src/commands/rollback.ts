import { Command } from 'commander';

export const rollbackCommand = new Command('rollback')
  .description('Rollback a module to a previous version')
  .requiredOption('--workspace <slug>', 'Workspace slug')
  .requiredOption('--module <id>', 'Module ID')
  .requiredOption('--env <env>', 'Environment')
  .requiredOption('--version-id <id>', 'Target Module version ID to rollback to')
  .action(async (options, command) => {
    // API call omitted for brevity in stub
    const parentOpts = command.parent?.opts() || {};
    if (parentOpts.json) {
      console.log(JSON.stringify({ success: true }));
    } else {
      console.log(`Successfully rolled back ${options.module} to version ${options.versionId} in ${options.env}`);
    }
  });
