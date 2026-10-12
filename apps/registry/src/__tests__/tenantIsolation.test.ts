// Copyright The Harmoniq Authors
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'crypto';
import { FastifyInstance } from 'fastify';
import { buildApp } from '../app';
import { Fixtures, bearer } from './helpers/fixtures';

/**
 * MT-10: two organizations, each with workspaces, modules, versions, keys, members, audit
 * events and domains. Every GET route of the API is called as organization A's admin (and
 * with A's org key), with A's slugs in the path, and no response may mention anything of
 * organization B. New routes are covered automatically.
 */
describe('Cross-organization isolation (MT-10)', () => {
  let app: FastifyInstance;
  let fx: Fixtures;
  let alice: string;
  let aliceKey: string;
  const run = randomUUID().slice(0, 8);
  const a = { org: `iso-a-${run}`, ws: `iso-a-${run}-ws`, module: `amod${run}` };
  const b = {
    org: `iso-b-${run}`,
    ws: `iso-b-${run}-ws`,
    module: `bmod${run}`,
    email: `bob-${run}@test.local`,
    domain: `b-${run}.example.test`,
  };
  /** Everything identifying organization B that must never show up for A. */
  const bMarkers: string[] = [];

  const api = (as: string, method: 'GET' | 'POST' | 'PUT', url: string, payload?: object) =>
    app.inject({ method, url, payload, headers: bearer(as) });
  const db = () => app.container.systemDb;

  async function seed(
    side: { org: string; ws: string; module: string },
    admin: string,
    shared: boolean
  ) {
    expect(
      (await api(admin, 'POST', '/api/orgs', { name: side.org, slug: side.org })).statusCode
    ).toBe(201);
    expect(
      (
        await api(admin, 'POST', `/api/orgs/${side.org}/workspaces`, {
          name: side.ws,
          slug: side.ws,
        })
      ).statusCode
    ).toBe(201);
    const workspace = await db().workspace.findUniqueOrThrow({ where: { slug: side.ws } });
    const hostApp = await db().hostApp.findFirstOrThrow({ where: { workspaceId: workspace.id } });
    const env = await db().environment.findFirstOrThrow({
      where: { hostAppId: hostApp.id, slug: 'production' },
    });
    const module = await db().remoteModule.create({
      data: {
        workspaceId: workspace.id,
        hostAppId: hostApp.id,
        name: side.module,
        slug: side.module,
        orgShared: shared,
      },
    });
    const version = await db().moduleVersion.create({
      data: {
        workspaceId: workspace.id,
        remoteModuleId: module.id,
        environmentId: env.id,
        version: '1.0.0',
        url: `https://cdn.example.test/${side.module}/1.0.0.js`,
        integrity: 'sha384-test',
        status: 'active',
        activatedAt: new Date(),
        deployedBy: 'test',
        deployedByType: 'user',
      },
    });
    const key = (
      await api(admin, 'POST', `/api/orgs/${side.org}/keys`, {
        name: `${side.org}-ci`,
        scopes: ['admin'],
      })
    ).json();
    const wsKey = (
      await api(admin, 'POST', `/api/workspaces/${side.ws}/api-keys`, {
        name: `${side.ws}-ci`,
        scopes: ['deploy:write'],
      })
    ).json();
    const org = await db().organization.findUniqueOrThrow({ where: { slug: side.org } });
    return { org, workspace, module, version, key, wsKey, hostApp };
  }

  beforeAll(async () => {
    app = await buildApp();
    await app.ready();
    fx = new Fixtures(app);
    const aliceUser = await fx.user();
    const bobUser = await db().user.create({ data: { email: b.email } });
    alice = await fx.session(aliceUser);
    const bob = await fx.session(bobUser);

    const A = await seed(a, alice, true);
    aliceKey = A.key.key;
    // B shares its module too: sharing must stay inside B's organization.
    const B = await seed(b, bob, true);
    await api(bob, 'POST', `/api/orgs/${b.org}/domains`, { domain: b.domain });
    bMarkers.push(
      b.org,
      B.org.id,
      b.ws,
      B.workspace.id,
      b.module,
      B.module.id,
      B.version.id,
      B.key.id,
      B.wsKey.id,
      b.email,
      bobUser.id,
      b.domain
    );
  });

  afterAll(async () => {
    await db().workspace.deleteMany({ where: { organization: { slug: { in: [a.org, b.org] } } } });
    await db().organization.deleteMany({ where: { slug: { in: [a.org, b.org] } } });
    await db().user.deleteMany({ where: { email: b.email } });
    await fx.cleanup();
    await app.close();
  });

  /** Every GET path of the API with organization A's values filled in. */
  function readPaths(): string[] {
    const spec = app.swagger() as { paths: Record<string, Record<string, unknown>> };
    const values: Record<string, string> = {
      orgSlug: a.org,
      workspaceSlug: a.ws,
      moduleRef: a.module,
      hostAppSlug: 'default',
      envSlug: 'production',
      env: 'production',
      domain: `a-${run}.example.test`,
    };
    return Object.entries(spec.paths)
      .filter(([, ops]) => 'get' in ops)
      .map(([path]) => path.replace(/\{(\w+)\}/g, (_, name: string) => values[name] ?? 'x'));
  }

  it('never shows organization B to organization A', async () => {
    const paths = readPaths();
    expect(paths.length).toBeGreaterThan(40);
    const leaks: string[] = [];
    const errors: string[] = [];
    let answered = 0;
    for (const path of paths) {
      for (const [who, token] of [
        ['user', alice],
        ['org key', aliceKey],
      ] as const) {
        const res = await app.inject({ method: 'GET', url: path, headers: bearer(token) });
        if (res.statusCode >= 500) errors.push(`${who} ${path} → ${res.statusCode}`);
        if (res.statusCode === 200) answered++;
        for (const marker of bMarkers) {
          if (res.body.includes(marker)) leaks.push(`${who} ${path} → ${marker}`);
        }
      }
    }
    expect(errors).toEqual([]);
    expect(leaks).toEqual([]);
    // The sweep reached real data, not just refusals.
    expect(answered).toBeGreaterThan(40);
  });

  it("answers 404 or 403 for organization B's own routes", async () => {
    for (const path of [
      `/api/orgs/${b.org}`,
      `/api/orgs/${b.org}/members`,
      `/api/orgs/${b.org}/modules`,
      `/api/orgs/${b.org}/audit`,
      `/api/orgs/${b.org}/keys`,
      `/api/orgs/${b.org}/domains`,
      `/api/workspaces/${b.ws}`,
      `/api/workspaces/${b.ws}/modules`,
      `/api/workspaces/${b.ws}/audit`,
    ]) {
      for (const token of [alice, aliceKey]) {
        const res = await app.inject({ method: 'GET', url: path, headers: bearer(token) });
        expect([403, 404], `${path} → ${res.statusCode}`).toContain(res.statusCode);
      }
    }
  });

  it("keeps B's shared module out of A's manifests", async () => {
    const manifest = await app.inject({
      method: 'GET',
      url: `/api/manifest/${a.ws}/default/production`,
    });
    expect(manifest.statusCode).toBe(200);
    expect(manifest.body).toContain(a.module);
    for (const marker of bMarkers) expect(manifest.body).not.toContain(marker);
  });
});
