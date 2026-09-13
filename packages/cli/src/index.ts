#!/usr/bin/env node

import { Command } from 'commander';
import { loginCommand } from './commands/login';
import { whoamiCommand } from './commands/whoami';
import { deployCommand } from './commands/deploy';
import { promoteCommand } from './commands/promote';
import { rollbackCommand } from './commands/rollback';
import { validateCommand } from './commands/validate';

const program = new Command();

program
  .name('harmoniq')
  .description('Harmoniq CLI for CI/CD deployments and validation')
  .version('1.0.0')
  .option('--json', 'output in JSON format for machines', false)
  .option(
    '--registry-url <url>',
    'Registry URL',
    process.env.HARMONIQ_REGISTRY_URL || 'http://localhost:3000'
  )
  .option('--api-key <key>', 'Harmoniq API Key', process.env.HARMONIQ_API_KEY)
  .option('--profile <name>', 'Workspace profile name', 'default');

program.addCommand(loginCommand);
program.addCommand(whoamiCommand);
program.addCommand(deployCommand);
program.addCommand(promoteCommand);
program.addCommand(rollbackCommand);
program.addCommand(validateCommand);

program.parse(process.argv);
