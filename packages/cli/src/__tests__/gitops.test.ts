// Copyright The Harmoniq Authors
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { setupServer } from 'msw/node';
import { http, HttpResponse } from 'msw';
import { parse } from 'yaml';
import { run } from '../index';

const REGISTRY = 'http://registry.test';
const KEY = 'hq_key1_secret';

let received: { body: Record<string, unknown> } | null = null;

const server = setupServer(
  http.post(`${REGISTRY}/api/workspaces/acme/apply`, async ({ request }) => {
    const body = (await request.json()) as Record<string, unknown>;
    received = { body };
    const changes = [
      { action: 'create', type: 'hostApp', key: 'shop' },
      { action: 'update', type: 'module', key: 'shop/cart', fields: ['specifier'] },
      {
        action: 'delete',
        type: 'hostApp',
        key: 'portal',
        blocked: 'it still serves module versions',
      },
    ];
    return HttpResponse.json({
      dryRun: body.dryRun,
      prune: body.prune,
      changes,
      summary: { create: 1, update: 1, delete: 0, blocked: 1 },
      ...(!body.dryRun && { secrets: { 'https://hooks.test': 'whsec_once' } }),
    });
  }),
  http.get(`${REGISTRY}/api/workspaces/acme/config`, () =>
    HttpResponse.json({ version: 1, workspace: 'acme', hostApps: [{ slug: 'portal' }] })
  )
);

describe('harmoniq plan / apply / import (IaC-10..12)', () => {
  let dir: string;
  let stdout: string[];
  let stderr: string[];
  const cli = (...args: string[]) =>
    run(['node', 'harmoniq', '--registry-url', REGISTRY, '--api-key', KEY, ...args]);

  beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
  afterAll(() => server.close());
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'harmoniq-gitops-'));
    process.env.HARMONIQ_CONFIG_DIR = dir;
    received = null;
    stdout = [];
    stderr = [];
    vi.spyOn(console, 'log').mockImplementation((m) => void stdout.push(String(m)));
    vi.spyOn(console, 'error').mockImplementation((m) => void stderr.push(String(m)));
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    delete process.env.HARMONIQ_CONFIG_DIR;
    delete process.env.HOOK_SECRET;
    await rm(dir, { recursive: true, force: true });
  });

  const writeConfig = (text: string) => writeFile(join(dir, 'harmoniq.yaml'), text);
  const file = () => join(dir, 'harmoniq.yaml');
  const CONFIG = `version: 1
workspace: acme
webhooks:
  - url: https://hooks.test
    events: [deploy.success]
    secret: \${HOOK_SECRET}
`;

  it('plans with secrets from the environment, never sending a placeholder', async () => {
    await writeConfig(CONFIG);
    process.env.HOOK_SECRET = 'from-ci-secret-value';
    expect(await cli('plan', '-f', file())).toBe(0);
    expect(received!.body).toMatchObject({ dryRun: true, prune: false });
    expect((received!.body.config as { webhooks: { secret: string }[] }).webhooks[0].secret).toBe(
      'from-ci-secret-value'
    );
    const out = stdout.join('\n');
    expect(out).toContain('+ hostApp shop');
    expect(out).toContain('~ module shop/cart (specifier)');
    expect(out).toContain('- hostApp portal  [blocked: it still serves module versions]');
    expect(out).toContain('Plan: 1 to create, 1 to update, 0 to delete, 1 blocked.');
  });

  it('fails when a referenced variable is missing, or the file is not YAML', async () => {
    await writeConfig(CONFIG);
    expect(await cli('plan', '-f', file())).toBe(2);
    expect(stderr.join('\n')).toContain('HOOK_SECRET');
    expect(received).toBeNull();
    await writeConfig('version: [1');
    expect(await cli('plan', '-f', file())).toBe(2);
  });

  it('flags drift with --detailed-exitcode', async () => {
    await writeConfig('version: 1\nworkspace: acme\n');
    expect(await cli('plan', '-f', file(), '--detailed-exitcode')).toBe(7);
  });

  it('applies with prune and prints generated secrets once', async () => {
    await writeConfig('version: 1\nworkspace: acme\n');
    expect(await cli('apply', '-f', file(), '--prune')).toBe(0);
    expect(received!.body).toMatchObject({ dryRun: false, prune: true });
    expect(stdout.join('\n')).toContain('Webhook https://hooks.test signing secret (shown once)');
  });

  it('imports the workspace as YAML and does not overwrite by accident', async () => {
    const out = join(dir, 'out.yaml');
    expect(await cli('--workspace', 'acme', 'import', '-o', out)).toBe(0);
    expect(parse(await readFile(out, 'utf8'))).toEqual({
      version: 1,
      workspace: 'acme',
      hostApps: [{ slug: 'portal' }],
    });
    expect(await cli('--workspace', 'acme', 'import', '-o', out)).toBe(5);
    expect(await cli('--workspace', 'acme', 'import', '-o', out, '--force')).toBe(0);
  });
});
