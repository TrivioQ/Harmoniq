// Copyright The Harmoniq Authors
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { computeIntegrity } from '@harmoniq/core/dist/validation/bundle';
import { harmoniq, harmoniqDeploy } from '../index';

const ENTRY = 'var checkout = { get() {}, init() {} };';

describe('@harmoniq/build-plugin', () => {
  let outDir: string;
  let fetchMock: ReturnType<typeof vi.fn>;
  const log = vi.fn();

  const base = () => ({
    module: 'checkout',
    environment: 'staging',
    version: '1.2.3',
    url: 'https://cdn.example.com/checkout/1.2.3/remoteEntry.js',
    outDir,
    registryUrl: 'http://registry.test/',
    apiKey: 'hq_key_secret',
    workspace: 'acme',
    log,
  });

  beforeEach(async () => {
    outDir = await mkdtemp(join(tmpdir(), 'harmoniq-build-'));
    await writeFile(join(outDir, 'remoteEntry.js'), ENTRY);
    fetchMock = vi.fn(
      async () => new Response(JSON.stringify({ manifestEtag: 'sha256-x' }), { status: 201 })
    );
    vi.stubGlobal('fetch', fetchMock);
    delete process.env.CI;
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    log.mockReset();
    await rm(outDir, { recursive: true, force: true });
  });

  const expectedIntegrity = () =>
    computeIntegrity(new TextEncoder().encode(ENTRY).buffer as ArrayBuffer, 'sha384');

  it('only computes the integrity outside CI', async () => {
    const result = await harmoniqDeploy(base());
    expect(result).toEqual({
      integrity: await expectedIntegrity(),
      exposes: undefined,
      deployed: false,
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('deploys in CI with the computed integrity, commit and MF exposes', async () => {
    process.env.CI = 'true';
    process.env.GITHUB_SHA = 'abc123';
    await writeFile(
      join(outDir, 'mf-manifest.json'),
      JSON.stringify({ exposes: [{ name: 'CheckoutPage', path: './CheckoutPage' }] })
    );
    try {
      const result = await harmoniqDeploy(base());
      expect(result.deployed).toBe(true);
      const [url, init] = fetchMock.mock.calls[0];
      expect(url).toBe('http://registry.test/api/workspaces/acme/modules/checkout/deploy');
      expect(init.headers.Authorization).toBe('Bearer hq_key_secret');
      expect(JSON.parse(init.body)).toEqual({
        environment: 'staging',
        url: 'https://cdn.example.com/checkout/1.2.3/remoteEntry.js',
        version: '1.2.3',
        integrity: await expectedIntegrity(),
        commitSha: 'abc123',
        exposes: { './CheckoutPage': 'CheckoutPage' },
        dryRun: false,
      });
    } finally {
      delete process.env.CI;
      delete process.env.GITHUB_SHA;
    }
  });

  it('sends shared dependencies from mf-manifest.json for the dependency gate', async () => {
    await writeFile(
      join(outDir, 'mf-manifest.json'),
      JSON.stringify({
        shared: [
          { name: 'react', version: '18.3.1', requiredVersion: '^18.2.0' },
          { name: 'lodash', version: '4.17.21', requiredVersion: false },
        ],
      })
    );
    const result = await harmoniqDeploy({
      ...base(),
      deploy: true,
      force: true,
      dependencies: { 'react-dom': '^18.2.0' },
    });
    expect(result.dependencies).toEqual({
      react: '^18.2.0',
      lodash: '^4.17.21',
      'react-dom': '^18.2.0',
    });
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body).toMatchObject({ dependencies: result.dependencies, force: true });
  });

  it('reports a deploy waiting for approval instead of claiming it happened', async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ status: 'pending_approval', requestId: 'req1' }), {
        status: 202,
      })
    );
    const result = await harmoniqDeploy({ ...base(), deploy: true, changeTicket: 'OPS-1' });
    expect(result).toMatchObject({ deployed: false, pendingApproval: 'req1' });
    expect(fetchMock.mock.calls[0][1].headers['X-Harmoniq-Change-Ticket']).toBe('OPS-1');
  });

  it('fails the build when the registry rejects the deploy', async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ error: { message: 'Environment "production" is frozen' } }), {
        status: 423,
      })
    );
    await expect(harmoniqDeploy({ ...base(), deploy: true })).rejects.toThrow('is frozen');
  });

  it('explains missing configuration and a missing entry file', async () => {
    await expect(
      harmoniqDeploy({ ...base(), deploy: true, apiKey: undefined, workspace: undefined })
    ).rejects.toThrow('apiKey / HARMONIQ_API_KEY, workspace / HARMONIQ_WORKSPACE');
    await expect(harmoniqDeploy({ ...base(), entry: 'missing.js' })).rejects.toThrow(
      'Remote entry not found'
    );
  });

  it('runs from the bundler writeBundle hook (Vite adapter)', async () => {
    const plugin = harmoniq.vite({ ...base(), deploy: true }) as {
      name: string;
      writeBundle: () => Promise<void>;
    };
    expect(plugin.name).toBe('harmoniq');
    await plugin.writeBundle();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
