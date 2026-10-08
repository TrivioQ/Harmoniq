import { Command } from 'commander';
import { notImplemented } from '../lib/notImplemented';

export const loginCommand = new Command('login')
  .description('Login to Harmoniq Registry')
  .action(() => notImplemented('login'));
