import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { FastifyInstance } from 'fastify';
import { buildApp } from '../app';
import { handleExpireEnvironments } from '../jobs/gc';
import { ConsoleLogger } from '../adapters/ConsoleLogger';
import { invalidateManifest } from '../services/cacheKeys';
import { Fixtures, bearer } from './helpers/fixtures';

describe('Preview environments (M2.6)', () => {
  let app: FastifyInstance;
  let fx: Fixtures;
  let ws: string;
  let token: string;

  const api = (method: 'GET' | 'POST' | 'PATCH', url: string, payload?: object) =>
    app.inject({ method, url, payload, headers: bearer(token) });
  const deployPreview = (env: string, ttlHours = 24) =>
    api('POST', `/api/workspaces/${ws}/modules/checkout/deploy`, {
      environment: env,
      url: 'https://cdn.example.com/checkout/pr/remoteEntry.js',
      version: `pr-${Date.now()}`,
      integrity: 'sha384-pr',
      ephemeral: { ttlHours },
    });
  const environment = (slug: string) =>
    app.container.systemDb.environment.findFirst({
      where: { slug, hostApp: { workspace: { slug: ws } } },
    });

  beforeAll(async () => {
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
  });

  it('are off unless the workspace allows them', async () => {
    expect((await deployPreview('pr-1')).statusCode).toBe(403);
    expect(await environment('pr-1')).toBeNull();
  });

  it('are created on first deploy with an expiry and a preview link', async () => {
    await api('PATCH', `/api/workspaces/${ws}`, { allowEphemeralEnvironments: true });
    await api('PATCH', `/api/workspaces/${ws}/host-apps/portal`, {
      previewUrlTemplate: 'https://staging.acme.com/?harmoniq-env={environment}',
    });

    const res = await deployPreview('pr-1', 48);
    expect(res.statusCode).toBe(201);
    expect(res.json().previewUrl).toBe('https://staging.acme.com/?harmoniq-env=pr-1');

    const env = await environment('pr-1');
    expect(env).toMatchObject({ ephemeral: true });
    const hours = (env!.expiresAt!.getTime() - Date.now()) / 3_600_000;
    expect(hours).toBeGreaterThan(47);
    expect(hours).toBeLessThanOrEqual(48);

    const manifest = await app.inject({ method: 'GET', url: `/api/manifest/${ws}/portal/pr-1` });
    expect(manifest.json().modules[0].name).toBe('checkout');
  });

  it('push back the expiry on later deploys', async () => {
    const before = (await environment('pr-1'))!.expiresAt!;
    await deployPreview('pr-1', 72);
    expect((await environment('pr-1'))!.expiresAt!.getTime()).toBeGreaterThan(before.getTime());
  });

  it('never turn a permanent environment into a preview one', async () => {
    expect((await deployPreview('staging')).statusCode).toBe(201);
    expect(await environment('staging')).toMatchObject({ ephemeral: false, expiresAt: null });
  });

  it('need a valid environment name', async () => {
    expect((await deployPreview('PR 1')).statusCode).toBe(400);
  });

  it('are deleted once expired, with their cached manifest', async () => {
    const env = (await environment('pr-1'))!;
    await app.container.systemDb.environment.update({
      where: { id: env.id },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });

    const deleted = await handleExpireEnvironments(
      app.container.systemDb,
      new ConsoleLogger(),
      async (e) => invalidateManifest(app.container.cache, ws, e.hostApp.slug, e.slug)
    );
    expect(deleted).toBeGreaterThanOrEqual(1);
    expect(await environment('pr-1')).toBeNull();
    const manifest = await app.inject({ method: 'GET', url: `/api/manifest/${ws}/portal/pr-1` });
    expect(manifest.statusCode).toBe(404);
  });

  it('validate preview URL templates', async () => {
    const res = await api('PATCH', `/api/workspaces/${ws}/host-apps/portal`, {
      previewUrlTemplate: 'https://staging.acme.com/',
    });
    expect(res.statusCode).toBe(400);
  });
});
