import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { deployCommand } from '../commands/deploy';
import { rollbackCommand } from '../commands/rollback';
import { promoteCommand } from '../commands/promote';
import { validateCommand } from '../commands/validate';
import { loginCommand } from '../commands/login';
import { whoamiCommand } from '../commands/whoami';
import { Command } from 'commander';
import { setupServer } from 'msw/node';
import { http, HttpResponse } from 'msw';

const server = setupServer(
  http.post('http://registry.test/api/workspaces/acme/modules/header/deploy', () => {
    return HttpResponse.json({ success: true });
  })
);

describe('CLI Commands', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(process, 'exit').mockImplementation((code?: string | number | null | undefined) => {
      throw new Error(`Process exited with code ${code}`);
    });
  });

  it('deploy command executes successfully', async () => {
    server.listen();

    // Simulate commander program
    const program = new Command();
    program.addCommand(deployCommand);

    // Configure program with the expected options
    program.option('--registry-url <url>', 'Registry URL');
    program.option('--api-key <key>', 'Harmoniq API Key');
    program.option('--json', 'JSON output');

    // Default mock values
    program.setOptionValue('registryUrl', 'http://registry.test');
    program.setOptionValue('apiKey', 'test-key');
    program.setOptionValue('json', true);

    await program.parseAsync([
      'node',
      'test',
      'deploy',
      '--workspace',
      'acme',
      '--module',
      'header',
      '--env',
      'prod',
      '--url',
      'http://cdn.com/test.js',
      '--version-id',
      '1.0.0',
      '--integrity',
      'sha384-xyz',
    ]);

    expect(console.log).toHaveBeenCalledWith(JSON.stringify({ success: true }));

    server.close();
  });

  // Unimplemented commands must never report success (product-analysis §3.8).
  it.each([
    ['rollback', ['--workspace', 'a', '--module', 'm', '--env', 'prod', '--version-id', 'v']],
    [
      'promote',
      [
        '--workspace',
        'a',
        '--module',
        'm',
        '--source-env',
        's',
        '--target-env',
        'p',
        '--version-id',
        'v',
      ],
    ],
    ['validate', ['--url', 'https://cdn.example.com/x.js', '--integrity', 'sha384-x']],
    ['login', []],
    ['whoami', []],
  ])('%s exits non-zero without claiming success', async (name, args) => {
    const program = new Command();
    for (const command of [
      rollbackCommand,
      promoteCommand,
      validateCommand,
      loginCommand,
      whoamiCommand,
    ]) {
      program.addCommand(command);
    }

    await expect(program.parseAsync(['node', 'test', name, ...args])).rejects.toThrow(
      'Process exited with code 1'
    );
    expect(console.log).not.toHaveBeenCalled();
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('not implemented'));
  });
});
