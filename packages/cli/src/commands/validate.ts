import { Command } from 'commander';
import { notImplemented } from '../lib/notImplemented';

export const validateCommand = new Command('validate')
  .description('Validate a module bundle URL and integrity')
  .requiredOption('--url <url>', 'Module bundle URL')
  .requiredOption('--integrity <hash>', 'Subresource integrity hash')
  .action(() => notImplemented('validate'));
