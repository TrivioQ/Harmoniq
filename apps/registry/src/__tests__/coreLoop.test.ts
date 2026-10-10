// Copyright The Harmoniq Authors
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { FastifyInstance } from 'fastify';
import { ManifestSchema } from '@harmoniq/core/dist/schemas/ManifestSchema';
import { buildApp } from '../app';
import { Fixtures, bearer } from './helpers/fixtures';

/**
 * M1 core loop: deploy → manifest → promote → rollback, with audit, snapshots, diff and
 * freezes. Runs sequentially; each step builds on the previous one.
 */
describe('Core loop', () => {
  let app: FastifyInstance;
  let fx: Fixtures;
  let ws: string;
  let token: string;

  const v = (n: string) => ({
    url: `https://cdn.example.com/checkout/${n}/remoteEntry.js`,
    version: n,
    integrity: `sha384-checkout${n.replace(/\./g, '')}`,
  });

  const api = (
    method: 'GET' | 'POST' | 'PUT' | 'DELETE',
    url: string,
    payload?: object,
    headers = {}
  ) => app.inject({ method, url, payload, headers: { ...bearer(token), ...headers } });
  const manifest = (env: string, headers: Record<string, string> = {}) =>
    app.inject({ method: 'GET', url: `/api/manifest/${ws}/portal/${env}`, headers });
  const deploy = (env: string, version: string, extra: object = {}) =>
    api('POST', `/api/workspaces/${ws}/modules/checkout/deploy`, {
      environment: env,
      ...v(version),
      ...extra,
    });

  // Simulates a database outage for exactly one workspace lookup.
  let failWorkspaceLookup = false;

  beforeAll(async () => {
    app = await buildApp();
    await app.ready();
    app.container.systemDb.$use(async (params, next) => {
      if (failWorkspaceLookup && params.model === 'Workspace') {
        failWorkspaceLookup = false;
        throw new Error('connection refused');
      }
      return next(params);
    });
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

  it('serves an empty, schema-valid manifest with a strong ETag', async () => {
    const res = await manifest('staging');
    expect(res.statusCode).toBe(200);
    const body = ManifestSchema.parse(res.json());
    expect(body.modules).toEqual([]);
    expect(res.headers.etag).toBe(`"${body.etag}"`);
    expect(res.json()).not.toHaveProperty('_etag');

    expect(
      (await manifest('staging', { 'if-none-match': res.headers.etag as string })).statusCode
    ).toBe(304);
    expect(
      (await manifest('staging', { 'if-none-match': `W/${res.headers.etag}` })).statusCode
    ).toBe(304);
  });

  it('deploys to the requested environment only', async () => {
    const before = (await manifest('staging')).headers.etag as string;

    const res = await deploy('staging', '1.0.0', { commitSha: 'abc123', metadata: { pr: 42 } });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({
      environment: 'staging',
      status: 'active',
      commitSha: 'abc123',
    });

    const staging = await manifest('staging', { 'if-none-match': before });
    expect(staging.statusCode).toBe(200); // the old ETag no longer matches
    const body = ManifestSchema.parse(staging.json());
    expect(body.modules).toEqual([
      expect.objectContaining({
        name: 'checkout',
        version: '1.0.0',
        metadata: expect.objectContaining({ commitSha: 'abc123', pr: 42 }),
      }),
    ]);
    expect(ManifestSchema.parse((await manifest('production')).json()).modules).toEqual([]);
  });

  it('promotes the exact artifact to production', async () => {
    const res = await api('POST', `/api/workspaces/${ws}/modules/checkout/promote`, {
      fromEnvironment: 'staging',
      toEnvironment: 'production',
    });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ environment: 'production', promotedFromEnv: 'staging' });

    const prod = ManifestSchema.parse((await manifest('production')).json());
    expect(prod.modules[0]).toMatchObject(v('1.0.0'));
  });

  it('rolls back to the previous version', async () => {
    expect((await deploy('production', '2.0.0')).statusCode).toBe(201);
    expect(ManifestSchema.parse((await manifest('production')).json()).modules[0].version).toBe(
      '2.0.0'
    );

    const res = await api('POST', `/api/workspaces/${ws}/modules/checkout/rollback`, {
      environment: 'production',
      previous: true,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ version: '1.0.0', status: 'active' });
    expect(ManifestSchema.parse((await manifest('production')).json()).modules[0].version).toBe(
      '1.0.0'
    );
  });

  it('refuses to roll back to the already-active version', async () => {
    const res = await api('POST', `/api/workspaces/${ws}/modules/checkout/rollback`, {
      environment: 'production',
      version: '1.0.0',
    });
    expect(res.statusCode).toBe(409);
  });

  it('records every change in the audit log', async () => {
    const res = await api('GET', `/api/workspaces/${ws}/audit?action=module.`);
    expect(res.json().events.map((e: { action: string }) => e.action)).toEqual([
      'module.rollback',
      'module.deploy',
      'module.promote',
      'module.deploy',
    ]);
    const promote = res.json().events[2];
    expect(promote.metadata).toMatchObject({
      fromEnvironment: 'staging',
      toEnvironment: 'production',
    });
  });

  it('snapshots every manifest change and diffs them', async () => {
    const list = await api('GET', `/api/manifest/${ws}/portal/production/snapshots`);
    const snapshots = list.json().snapshots;
    expect(snapshots.map((s: { cause: { action: string } }) => s.cause.action)).toEqual([
      'module.rollback',
      'module.deploy',
      'module.promote',
    ]);

    const [rolledBack, v2] = snapshots;
    const full = await api('GET', `/api/manifest/${ws}/portal/production/snapshots/${v2.id}`);
    expect(ManifestSchema.parse(full.json()).modules[0].version).toBe('2.0.0');

    const diff = await api(
      'GET',
      `/api/manifest/${ws}/portal/production/diff?from=${v2.id}&to=${rolledBack.id}`
    );
    expect(diff.json().changed).toEqual([
      expect.objectContaining({ name: 'checkout', fields: ['version', 'url', 'integrity'] }),
    ]);
  });

  it('blocks changes to a frozen environment but keeps serving it', async () => {
    const freezeUrl = `/api/workspaces/${ws}/host-apps/portal/environments/production/freeze`;
    expect((await api('PUT', freezeUrl, { reason: 'Black Friday' })).statusCode).toBe(200);

    const blocked = await deploy('production', '3.0.0');
    expect(blocked.statusCode).toBe(423);
    expect(blocked.json().error.message).toContain('Black Friday');
    const promote = await api('POST', `/api/workspaces/${ws}/modules/checkout/promote`, {
      fromEnvironment: 'staging',
      toEnvironment: 'production',
    });
    expect(promote.statusCode).toBe(423);
    expect((await manifest('production')).statusCode).toBe(200); // ENV-FRZ-06
    expect((await deploy('staging', '3.0.0')).statusCode).toBe(201); // other envs unaffected

    expect((await api('DELETE', freezeUrl)).statusCode).toBe(200);
    expect((await deploy('production', '3.0.0')).statusCode).toBe(201);
  });

  it('serves the legacy endpoint from the default host app', async () => {
    const legacy = await app.inject({ method: 'GET', url: `/api/manifest/${ws}/production` });
    expect(ManifestSchema.parse(legacy.json()).hostApp.slug).toBe('portal');
  });

  it('serves the last-known-good manifest when the database is down', async () => {
    await app.container.cache.invalidatePattern(`manifest:${ws}:*`);
    failWorkspaceLookup = true;
    const res = await manifest('production');
    expect(res.statusCode).toBe(200);
    expect(res.headers['x-harmoniq-stale']).toBe('true');
    expect(ManifestSchema.parse(res.json()).modules[0].version).toBe('3.0.0');
  });

  it('validates on dry run without deploying, refusing internal URLs', async () => {
    const res = await deploy('production', '9.9.9', {
      url: 'http://169.254.169.254/latest/meta-data',
      dryRun: true,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ dryRun: true, validation: { urlReachable: false } });
    expect(res.json().validation.errors[0]).toContain('private');
    expect(res.json().projectedDiff.changed[0]).toMatchObject({ name: 'checkout' });
    expect(ManifestSchema.parse((await manifest('production')).json()).modules[0].version).toBe(
      '3.0.0'
    );
  });

  it('lists modules with the active version per environment', async () => {
    const res = await api('GET', `/api/workspaces/${ws}/modules`);
    const checkout = res.json().modules[0];
    expect(
      checkout.environments.map((e: { slug: string; active: { version: string } }) => [
        e.slug,
        e.active?.version,
      ])
    ).toEqual([
      ['production', '3.0.0'],
      ['staging', '3.0.0'],
    ]);
  });

  it('does not let viewers deploy', async () => {
    const viewer = await fx.user();
    const { id } = (await app.container.systemDb.workspace.findUnique({ where: { slug: ws } }))!;
    await fx.member(id, viewer.id, 'viewer');
    const res = await app.inject({
      method: 'POST',
      url: `/api/workspaces/${ws}/modules/checkout/deploy`,
      headers: bearer(await fx.session(viewer)),
      payload: { environment: 'staging', ...v('4.0.0') },
    });
    expect(res.statusCode).toBe(403);
  });
});
