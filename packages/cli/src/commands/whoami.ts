import { Command } from 'commander';
import { notImplemented } from '../lib/notImplemented';

export const whoamiCommand = new Command('whoami')
  .description('Check current authentication status')
  .action(() => notImplemented('whoami'));
