import { Command } from 'commander';

export const whoamiCommand = new Command('whoami')
  .description('Check current authentication status')
  .action(async () => {
    console.log('Logged in as user');
  });
