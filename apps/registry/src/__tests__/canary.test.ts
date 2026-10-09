import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { FastifyInstance } from 'fastify';
import { ManifestSchema } from '@harmoniq/core/dist/schemas/ManifestSchema';
import { buildApp } from '../app';
import {
  CanaryInfo,
  assignCanaries,
  bucketFor,
  cohortIdFor,
  userKeyFrom,
  variantKey,
} from '../services/canary';
import { Fixtures, bearer } from './helpers/fixtures';

const canary = (moduleId: string, trafficPercent: number): CanaryInfo => ({
  moduleId,
  module: moduleId,
  versionId: `v-${moduleId}`,
  version: '2.0.0',
  trafficPercent,
});

describe('Canary assignment', () => {
  const cohorts = Array.from({ length: 10_000 }, (_, i) => cohortIdFor('ws-1', `user-${i}`));

  it('is deterministic per user and never exposes the user id', () => {
    expect(cohortIdFor('ws-1', 'alice')).toBe(cohortIdFor('ws-1', 'alice'));
    expect(cohortIdFor('ws-1', 'alice')).not.toBe(cohortIdFor('ws-2', 'alice'));
    expect(cohortIdFor('ws-1', 'alice')).toMatch(/^[0-9a-f]{16}$/);
  });

  it('splits traffic within ±3% of the configured percentage over 10k users', () => {
    for (const percent of [1, 10, 50, 90]) {
      const share = cohorts.filter((c) => assignCanaries([canary('m1', percent)], c).length).length;
      expect(Math.abs(share / cohorts.length - percent / 100)).toBeLessThan(0.03);
    }
  });

  it('keeps users in the canary when its traffic is raised', () => {
    const at10 = cohorts.filter((c) => assignCanaries([canary('m1', 10)], c).length);
    expect(at10.every((c) => assignCanaries([canary('m1', 50)], c).length === 1)).toBe(true);
  });

  it('assigns modules independently', () => {
    const both = cohorts.filter(
      (c) => assignCanaries([canary('m1', 50), canary('m2', 50)], c).length === 2
    ).length;
    expect(Math.abs(both / cohorts.length - 0.25)).toBeLessThan(0.03);
    expect(bucketFor(cohorts[0], 'm1')).not.toBe(undefined);
  });

  it('shares one cache variant per set of canaries', () => {
    expect(variantKey([])).toBe('stable');
    expect(variantKey([canary('a', 5), canary('b', 5)])).toBe(
      variantKey([canary('b', 5), canary('a', 5)])
    );
    expect(variantKey([canary('a', 5)])).not.toBe(variantKey([canary('b', 5)]));
  });

  it('reads the user key from the header, then the cookie', () => {
    expect(userKeyFrom({ 'x-harmoniq-user-id': ' u1 ' })).toBe('u1');
    expect(userKeyFrom({ cookie: 'a=1; harmoniq_canary=abc%20d' })).toBe('abc d');
    expect(userKeyFrom({ 'x-harmoniq-user-id': '', cookie: 'other=1' })).toBeNull();
  });
});

describe('Canary releases', () => {
  let app: FastifyInstance;
  let fx: Fixtures;
  let ws: string;
  let workspaceId: string;
  let moduleId: string;
  let token: string;

  const v = (n: string) => ({
    url: `https://cdn.example.com/checkout/${n}/remoteEntry.js`,
    version: n,
    integrity: `sha384-checkout${n.replace(/\./g, '')}`,
  });
  const api = (method: 'GET' | 'POST' | 'PUT', url: string, payload?: object) =>
    app.inject({ method, url, payload, headers: bearer(token) });
  const manifest = (user?: string, headers: Record<string, string> = {}) =>
    app.inject({
      method: 'GET',
      url: `/api/manifest/${ws}/portal/production`,
      headers: { ...(user && { 'x-harmoniq-user-id': user }), ...headers },
    });
  const deploy = (version: string, extra: object = {}) =>
    api('POST', `/api/workspaces/${ws}/modules/checkout/deploy`, {
      environment: 'production',
      ...v(version),
      ...extra,
    });
  const checkoutVersion = (res: { json(): unknown }) =>
    ManifestSchema.parse(res.json()).modules.find((m) => m.name === 'checkout')?.version;

  /** A user id whose bucket for the module is below (or at/above) `percent`. */
  function userIn(percent: number, inCanary: boolean) {
    for (let i = 0; ; i++) {
      const id = `user-${inCanary}-${i}`;
      const bucket = bucketFor(cohortIdFor(workspaceId, id), moduleId);
      if (inCanary === bucket < percent) return id;
    }
  }

  beforeAll(async () => {
    app = await buildApp();
    await app.ready();
    fx = new Fixtures(app);
    const { workspace, module } = await fx.workspace();
    ws = workspace.slug;
    workspaceId = workspace.id;
    moduleId = module.id;
    const owner = await fx.user();
    await fx.member(workspace.id, owner.id, 'owner');
    token = await fx.session(owner);
  });

  afterAll(async () => {
    await fx.cleanup();
    await app.close();
  });

  it('needs an active version to run a canary against', async () => {
    const res = await deploy('1.0.0', { canary: { trafficPercent: 10 } });
    expect(res.statusCode).toBe(409);
    expect((await deploy('1.0.0')).statusCode).toBe(201);
  });

  it('serves the canary only to users in its traffic share, stickily', async () => {
    const res = await deploy('2.0.0', { canary: { trafficPercent: 20 } });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ status: 'canary', trafficPercent: 20 });

    const inside = userIn(20, true);
    const outside = userIn(20, false);

    const canaryRes = await manifest(inside);
    expect(checkoutVersion(canaryRes)).toBe('2.0.0');
    const body = canaryRes.json();
    expect(body.variant).toBe('canary');
    expect(body.cohortId).toBe(cohortIdFor(workspaceId, inside));
    expect(body.modules[0].metadata.canary).toBe(true);
    expect(canaryRes.headers['x-harmoniq-variant']).toBe('canary');
    expect(canaryRes.headers['x-harmoniq-cohort-id']).toBe(body.cohortId);
    expect(canaryRes.headers['cache-control']).toBe('private, no-cache');
    expect(canaryRes.headers.vary).toContain('X-Harmoniq-User-Id');
    // Sticky, and served from the variant cache the second time.
    expect(checkoutVersion(await manifest(inside))).toBe('2.0.0');

    const stableRes = await manifest(outside);
    expect(checkoutVersion(stableRes)).toBe('1.0.0');
    expect(stableRes.json()).toMatchObject({
      variant: 'stable',
      cohortId: cohortIdFor(workspaceId, outside),
    });
    expect(stableRes.headers['cache-control']).toBe('no-cache');

    // No user key: stable, and the cookie works as a key too.
    expect(checkoutVersion(await manifest())).toBe('1.0.0');
    expect(
      checkoutVersion(await manifest(undefined, { cookie: `harmoniq_canary=${inside}` }))
    ).toBe('2.0.0');
  });

  it('lets cross-origin hosts read the ETag and variant headers', async () => {
    const res = await manifest(userIn(20, true), { origin: 'https://shop.example.com' });
    expect(res.headers['access-control-allow-origin']).toBe('*');
    expect(res.headers['access-control-expose-headers']).toEqual(expect.stringContaining('ETag'));
    expect(res.headers['access-control-expose-headers']).toContain('X-Harmoniq-Cohort-Id');
  });

  it('honours ETags per variant', async () => {
    const user = userIn(20, true);
    const first = await manifest(user);
    const again = await manifest(user, { 'if-none-match': first.headers.etag as string });
    expect(again.statusCode).toBe(304);
    const stable = await manifest(userIn(20, false));
    expect(stable.headers.etag).not.toBe(first.headers.etag);
  });

  it('adjusts traffic without a redeploy (CAN-05)', async () => {
    const user = userIn(60, true);
    expect(checkoutVersion(await manifest(user))).toBe(
      userIn(20, true) === user ? '2.0.0' : '1.0.0'
    );

    const res = await api('PUT', `/api/workspaces/${ws}/modules/checkout/canary`, {
      environment: 'production',
      trafficPercent: 60,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().trafficPercent).toBe(60);
    expect(checkoutVersion(await manifest(user))).toBe('2.0.0');
  });

  it('lists the canary with the module', async () => {
    const res = await api('GET', `/api/workspaces/${ws}/modules`);
    const prod = res
      .json()
      .modules.find((m: { slug: string }) => m.slug === 'checkout')
      .environments.find((e: { slug: string }) => e.slug === 'production');
    expect(prod.active.version).toBe('1.0.0');
    expect(prod.canary).toMatchObject({ version: '2.0.0', trafficPercent: 60 });
  });

  it('aborts the canary: everyone back on the active version', async () => {
    const user = userIn(60, true);
    const res = await api('POST', `/api/workspaces/${ws}/modules/checkout/canary/abort`, {
      environment: 'production',
      reason: 'error rate',
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('inactive');
    expect(checkoutVersion(await manifest(user))).toBe('1.0.0');
    expect((await manifest(user)).headers.vary ?? '').not.toContain('X-Harmoniq-User-Id');

    const again = await api('POST', `/api/workspaces/${ws}/modules/checkout/canary/abort`, {
      environment: 'production',
    });
    expect(again.statusCode).toBe(404);
  });

  it('restarts an earlier version as the canary and promotes it', async () => {
    const versions = await api(
      'GET',
      `/api/workspaces/${ws}/modules/checkout/versions?environment=production`
    );
    const v2 = versions.json().versions.find((x: { version: string }) => x.version === '2.0.0');
    const restart = await api('PUT', `/api/workspaces/${ws}/modules/checkout/canary`, {
      environment: 'production',
      trafficPercent: 5,
      versionId: v2.id,
    });
    expect(restart.statusCode).toBe(200);
    expect(restart.json()).toMatchObject({ status: 'canary', trafficPercent: 5 });

    const promote = await api('POST', `/api/workspaces/${ws}/modules/checkout/canary/promote`, {
      environment: 'production',
    });
    expect(promote.statusCode).toBe(200);
    expect(promote.json()).toMatchObject({ status: 'active', trafficPercent: null });
    expect(checkoutVersion(await manifest())).toBe('2.0.0');
    expect(checkoutVersion(await manifest(userIn(5, false)))).toBe('2.0.0');
  });

  it('ends a running canary on a normal deploy', async () => {
    await deploy('3.0.0', { canary: { trafficPercent: 50 } });
    const res = await deploy('3.1.0');
    expect(res.statusCode).toBe(201);
    expect(checkoutVersion(await manifest(userIn(50, true)))).toBe('3.1.0');

    const audit = await api('GET', `/api/workspaces/${ws}/audit?action=module.deploy`);
    const last = audit.json().events[0];
    expect(last.metadata.endedCanary.version).toBe('3.0.0');
  });

  it('records canary changes in the audit log and snapshots', async () => {
    const audit = await api('GET', `/api/workspaces/${ws}/audit`);
    const actions = audit.json().events.map((e: { action: string }) => e.action);
    expect(actions).toEqual(
      expect.arrayContaining(['canary.update', 'canary.abort', 'canary.start', 'canary.promote'])
    );
  });

  it('never rolls back to an aborted canary', async () => {
    await deploy('5.0.0');
    await deploy('5.1.0', { canary: { trafficPercent: 10 } });
    await api('POST', `/api/workspaces/${ws}/modules/checkout/canary/abort`, {
      environment: 'production',
    });
    await deploy('6.0.0');
    const res = await api('POST', `/api/workspaces/${ws}/modules/checkout/rollback`, {
      environment: 'production',
      previous: true,
    });
    expect(res.json().version).toBe('5.0.0');
  });

  it('is blocked by a freeze', async () => {
    await deploy('4.0.0', { canary: { trafficPercent: 10 } });
    const freeze = await api(
      'PUT',
      `/api/workspaces/${ws}/host-apps/portal/environments/production/freeze`,
      {
        reason: 'release',
      }
    );
    expect(freeze.statusCode).toBe(200);
    for (const res of [
      await api('PUT', `/api/workspaces/${ws}/modules/checkout/canary`, {
        environment: 'production',
        trafficPercent: 20,
      }),
      await api('POST', `/api/workspaces/${ws}/modules/checkout/canary/promote`, {
        environment: 'production',
      }),
    ]) {
      expect(res.statusCode).toBe(423);
    }
  });
});
