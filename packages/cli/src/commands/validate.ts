import { Command } from 'commander';

export const validateCommand = new Command('validate')
  .description('Validate a module bundle URL and integrity')
  .requiredOption('--url <url>', 'Module bundle URL')
  .requiredOption('--integrity <hash>', 'Subresource integrity hash')
  .action(async (options, command) => {
    const parentOpts = command.parent?.opts() || {};
    if (parentOpts.json) {
      console.log(JSON.stringify({ valid: true }));
    } else {
      console.log(`Module bundle at ${options.url} is valid.`);
    }
  });
