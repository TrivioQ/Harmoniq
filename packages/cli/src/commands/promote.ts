import { Command } from 'commander';
import { notImplemented } from '../lib/notImplemented';

export const promoteCommand = new Command('promote')
  .description('Promote a module version to another environment')
  .requiredOption('--workspace <slug>', 'Workspace slug')
  .requiredOption('--module <id>', 'Module ID')
  .requiredOption('--source-env <env>', 'Source Environment')
  .requiredOption('--target-env <env>', 'Target Environment')
  .requiredOption('--version-id <id>', 'Module version ID (semver)')
  .action(() => notImplemented('promote'));
