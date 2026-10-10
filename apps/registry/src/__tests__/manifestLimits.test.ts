// Copyright The Harmoniq Authors
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { FastifyInstance } from 'fastify';
import { buildApp } from '../app';
import { Fixtures, bearer } from './helpers/fixtures';

/** Public manifest endpoint under made-up slugs, cache misses and new environments. */
describe('Manifest endpoint robustness', () => {
  let app: FastifyInstance;
  let fx: Fixtures;
  let ws: string;
  let token: string;
  let workspaceQueries = 0;
  const previous = process.env.HARMONIQ_MANIFEST_MISS_LIMIT;

  const get = (url: string, ip = '203.0.113.10') =>
    app.inject({ method: 'GET', url, remoteAddress: ip });

  beforeAll(async () => {
    process.env.HARMONIQ_MANIFEST_MISS_LIMIT = '3';
    app = await buildApp();
    await app.ready();
    app.container.systemDb.$use(async (params, next) => {
      if (params.model === 'Workspace') workspaceQueries++;
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
    if (previous === undefined) delete process.env.HARMONIQ_MANIFEST_MISS_LIMIT;
    else process.env.HARMONIQ_MANIFEST_MISS_LIMIT = previous;
    await fx.cleanup();
    await app.close();
  });

  it('limits not-found answers per IP across made-up workspace slugs', async () => {
    const ip = '203.0.113.20';
    for (let i = 0; i < 3; i++) {
      expect((await get(`/api/manifest/nope-${i}/portal/production`, ip)).statusCode).toBe(404);
    }
    const before = workspaceQueries;
    const limited = await get(`/api/manifest/nope-x/portal/production`, ip);
    expect(limited.statusCode).toBe(429);
    expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0);
    // Also for real workspaces, and without any database lookup.
    expect((await get(`/api/manifest/${ws}/portal/production`, ip)).statusCode).toBe(429);
    expect((await get(`/api/importmap/nope-y/portal/production`, ip)).statusCode).toBe(429);
    expect(workspaceQueries).toBe(before);
    // Other clients are unaffected.
    expect((await get(`/api/manifest/${ws}/portal/production`, '203.0.113.21')).statusCode).toBe(
      200
    );
  });

  it('caches not-found briefly, and a new environment clears it', async () => {
    const url = `/api/manifest/${ws}/portal/qa`;
    expect((await get(url, '203.0.113.30')).statusCode).toBe(404);
    const before = workspaceQueries;
    expect((await get(url, '203.0.113.31')).statusCode).toBe(404);
    expect(workspaceQueries).toBe(before); // answered from the cache

    const created = await app.inject({
      method: 'POST',
      url: `/api/workspaces/${ws}/host-apps/portal/environments`,
      headers: bearer(token),
      payload: { name: 'QA', slug: 'qa' },
    });
    expect(created.statusCode).toBe(201);
    expect((await get(url, '203.0.113.32')).statusCode).toBe(200);
  });

  it('builds a missing manifest once for concurrent requests', async () => {
    const url = `/api/manifest/${ws}/portal/staging`;
    await get(url, '203.0.113.40'); // plan and caches warm
    await app.container.cache.invalidatePattern(`manifest:${ws}:*`);
    const before = workspaceQueries;
    const responses = await Promise.all(
      Array.from({ length: 8 }, (_, i) => get(url, `203.0.113.${50 + i}`))
    );
    expect(responses.every((r) => r.statusCode === 200)).toBe(true);
    // One build: the workspace lookup plus at most one more (org-shared modules).
    expect(workspaceQueries - before).toBeLessThanOrEqual(2);
  });

  it('serves a manifest even with a malformed canary cookie', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/manifest/${ws}/portal/production`,
      remoteAddress: '203.0.113.60',
      headers: { cookie: 'harmoniq_canary=%E0%A4%A' },
    });
    expect(res.statusCode).toBe(200);
  });
});
