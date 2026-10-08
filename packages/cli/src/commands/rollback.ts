import { Command } from 'commander';
import { notImplemented } from '../lib/notImplemented';

export const rollbackCommand = new Command('rollback')
  .description('Rollback a module to a previous version')
  .requiredOption('--workspace <slug>', 'Workspace slug')
  .requiredOption('--module <id>', 'Module ID')
  .requiredOption('--env <env>', 'Environment')
  .requiredOption('--version-id <id>', 'Target Module version ID to rollback to')
  .action(() => notImplemented('rollback'));
