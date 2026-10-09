import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { FastifyInstance } from 'fastify';
import { ManifestSchema } from '@harmoniq/core/dist/schemas/ManifestSchema';
import { buildApp } from '../app';
import { LocalStorageAdapter } from '../adapters/storage/LocalStorageAdapter';
import { Fixtures, bearer } from './helpers/fixtures';

describe('Manifest delivery (publishing, import maps, federation)', () => {
  let app: FastifyInstance;
  let fx: Fixtures;
  let dir: string;
  let ws: string;
  let token: string;

  const deploy = (env: string, version: string) =>
    app.inject({
      method: 'POST',
      url: `/api/workspaces/${ws}/modules/checkout/deploy`,
      headers: bearer(token),
      payload: {
        environment: env,
        url: `https://cdn.example.com/checkout/${version}/remoteEntry.js`,
        version,
        integrity: `sha384-c${version.replace(/\./g, '')}`,
      },
    });
  const published = async (kind: 'manifests' | 'importmaps', env: string) =>
    JSON.parse(await readFile(join(dir, kind, ws, 'portal', `${env}.json`), 'utf8'));

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'harmoniq-storage-'));
    process.env.STORAGE_ADAPTER = 'local';
    process.env.LOCAL_STORAGE_DIR = dir;
    process.env.PUBLIC_URL = 'http://registry.test';
    app = await buildApp();
    await app.ready();
    fx = new Fixtures(app);
    const { workspace } = await fx.workspace();
    ws = workspace.slug;
    const owner = await fx.user();
    await fx.member(workspace.id, owner.id, 'owner');
    token = await fx.session(owner);
  });

  afterAll(async () => {
    await fx.cleanup();
    await app.close();
    await rm(dir, { recursive: true, force: true });
    delete process.env.STORAGE_ADAPTER;
    delete process.env.LOCAL_STORAGE_DIR;
    delete process.env.PUBLIC_URL;
  });

  it('publishes the manifest and import map to storage on every change', async () => {
    expect((await deploy('staging', '1.0.0')).statusCode).toBe(201);

    const manifest = ManifestSchema.parse(await published('manifests', 'staging'));
    expect(manifest.modules[0]).toMatchObject({ name: 'checkout', version: '1.0.0' });
    expect(await published('importmaps', 'staging')).toEqual({
      imports: { checkout: 'https://cdn.example.com/checkout/1.0.0/remoteEntry.js' },
      integrity: { 'https://cdn.example.com/checkout/1.0.0/remoteEntry.js': 'sha384-c100' },
    });

    // The registry's own copy and the published copy agree.
    const live = await app.inject({ method: 'GET', url: `/api/manifest/${ws}/portal/staging` });
    expect(live.json().etag).toBe(manifest.etag);
  });

  it('serves locally published files with CDN cache headers', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/static/manifests/${ws}/portal/staging.json`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toBe('public, max-age=30, stale-while-revalidate=300');
    expect(res.headers['access-control-allow-origin']).toBe('*');
    expect(res.json().modules[0].version).toBe('1.0.0');
  });

  it('refuses paths outside the storage directory', async () => {
    const outside = join(dir, '..', `secret-${ws}.txt`);
    await writeFile(outside, 'TOP-SECRET-CONTENT');
    try {
      for (const url of [`/static/../secret-${ws}.txt`, `/static/%2e%2e/secret-${ws}.txt`]) {
        const res = await app.inject({ method: 'GET', url });
        expect(res.statusCode).toBe(404);
        expect(res.payload).not.toContain('TOP-SECRET-CONTENT');
      }
      const storage = app.container.instanceStorage!.storage as LocalStorageAdapter;
      await expect(storage.read(`../secret-${ws}.txt`)).rejects.toThrow('Invalid storage key');
    } finally {
      await rm(outside, { force: true });
    }
  });

  it('reports publish status per environment', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/workspaces/${ws}`,
      headers: bearer(token),
    });
    const staging = res
      .json()
      .hostApps[0].environments.find((e: { slug: string }) => e.slug === 'staging');
    expect(staging.published).toMatchObject({
      manifestUrl: `http://registry.test/static/manifests/${ws}/portal/staging.json`,
      error: null,
    });
    expect(staging.published.etag).toMatch(/^sha256-/);
  });

  it('serves an import map with its own ETag', async () => {
    const url = `/api/importmap/${ws}/portal/staging`;
    const res = await app.inject({ method: 'GET', url });
    expect(res.headers['content-type']).toContain('application/importmap+json');
    expect(res.json().imports.checkout).toContain('/1.0.0/');
    const again = await app.inject({
      method: 'GET',
      url,
      headers: { 'if-none-match': res.headers.etag as string },
    });
    expect(again.statusCode).toBe(304);
  });

  it('serves a Native Federation manifest', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/federation-manifest/${ws}/portal/staging`,
    });
    expect(res.json()).toEqual({
      checkout: 'https://cdn.example.com/checkout/1.0.0/remoteEntry.js',
    });
  });

  it('re-snapshots and republishes when a module specifier changes', async () => {
    const before = await app.inject({
      method: 'GET',
      url: `/api/manifest/${ws}/portal/staging/snapshots`,
      headers: bearer(token),
    });
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/workspaces/${ws}/modules/checkout`,
      headers: bearer(token),
      payload: { specifier: '@acme/checkout' },
    });
    expect(res.statusCode).toBe(200);

    expect(Object.keys((await published('importmaps', 'staging')).imports)).toEqual([
      '@acme/checkout',
    ]);
    const live = await app.inject({ method: 'GET', url: `/api/importmap/${ws}/portal/staging` });
    expect(live.json().imports['@acme/checkout']).toBeDefined();

    const after = await app.inject({
      method: 'GET',
      url: `/api/manifest/${ws}/portal/staging/snapshots`,
      headers: bearer(token),
    });
    expect(after.json().snapshots.length).toBe(before.json().snapshots.length + 1);
    expect(after.json().snapshots[0].cause.action).toBe('module.update');
  });

  it('rejects invalid specifiers', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/workspaces/${ws}/modules/checkout`,
      headers: bearer(token),
      payload: { specifier: 'Not A Specifier' },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe('Manifest publishing failures', () => {
  it('records the error without failing the deploy, and can be retried', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'harmoniq-storage-'));
    const blocker = join(dir, 'not-a-directory');
    await writeFile(blocker, 'x'); // storage root is a file: every write fails
    process.env.STORAGE_ADAPTER = 'local';
    process.env.LOCAL_STORAGE_DIR = blocker;
    const app = await buildApp();
    await app.ready();
    const fx = new Fixtures(app);
    try {
      const { workspace } = await fx.workspace();
      const key = (await fx.apiKey(workspace.id, { scopes: ['admin'] })).raw;
      const res = await app.inject({
        method: 'POST',
        url: `/api/workspaces/${workspace.slug}/modules/checkout/deploy`,
        headers: bearer(key),
        payload: {
          environment: 'production',
          url: 'https://cdn.example.com/checkout/1.0.0/remoteEntry.js',
          version: '1.0.0',
          integrity: 'sha384-c100',
        },
      });
      expect(res.statusCode).toBe(201); // the deploy itself succeeded

      const env = await app.container.systemDb.environment.findFirstOrThrow({
        where: { hostApp: { workspaceId: workspace.id }, slug: 'production' },
      });
      expect(env.lastPublishError).toBeTruthy();
      expect(env.lastPublishedEtag).toBeNull();

      const manual = await app.inject({
        method: 'POST',
        url: `/api/workspaces/${workspace.slug}/host-apps/portal/environments/production/publish`,
        headers: bearer(key),
      });
      expect(manual.statusCode).toBe(500); // still failing, and reported as such
    } finally {
      await fx.cleanup();
      await app.close();
      await rm(dir, { recursive: true, force: true });
      delete process.env.STORAGE_ADAPTER;
      delete process.env.LOCAL_STORAGE_DIR;
    }
  });
});
