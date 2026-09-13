import { Command } from 'commander';

export const loginCommand = new Command('login')
  .description('Login to Harmoniq Registry')
  .action(async (options, command) => {
    // In a real CLI, we would prompt or read from stdin, then write to ~/.harmoniq/config.json
    console.log('Login successful');
  });
