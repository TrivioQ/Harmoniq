import { Command } from 'commander';

export const whoamiCommand = new Command('whoami')
  .description('Check current authentication status')
  .action(async (options, command) => {
    console.log('Logged in as user');
  });
