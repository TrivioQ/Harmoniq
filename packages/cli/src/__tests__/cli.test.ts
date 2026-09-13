import { describe, it, expect, vi, beforeEach } from 'vitest';
import { deployCommand } from '../commands/deploy';
import { Command } from 'commander';
import { setupServer } from 'msw/node';
import { http, HttpResponse } from 'msw';

const server = setupServer(
  http.post('http://registry.test/api/workspaces/acme/modules/header/deploy', () => {
    return HttpResponse.json({ success: true });
  })
);

describe('CLI Commands', () => {
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
      'node', 'test', 'deploy',
      '--workspace', 'acme',
      '--module', 'header',
      '--env', 'prod',
      '--url', 'http://cdn.com/test.js',
      '--version-id', '1.0.0',
      '--integrity', 'sha384-xyz'
    ]);

    expect(console.log).toHaveBeenCalledWith(JSON.stringify({ success: true }));
    
    server.close();
  });
});
