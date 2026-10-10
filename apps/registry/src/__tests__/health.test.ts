// Copyright The Harmoniq Authors
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { FastifyInstance } from 'fastify';
import { buildApp } from '../app';
import { rollUpHealth, trendOf } from '../services/health';
import { Fixtures, bearer } from './helpers/fixtures';

describe('Module health (M3.2)', () => {
  let app: FastifyInstance;
  let fx: Fixtures;
  let ws: string;
  let workspaceId: string;
  let moduleId: string;
  let productionId: string;
  let token: string;

  const api = (method: 'GET' | 'POST', url: string, payload?: object) =>
    app.inject({ method, url, payload, headers: bearer(token) });
  /** As a browser's sendBeacon sends it: text/plain, cross-origin. */
  const report = (events: object[], env = 'production') =>
    app.inject({
      method: 'POST',
      url: `/api/health/${ws}/portal/${env}`,
      headers: { 'content-type': 'text/plain;charset=UTF-8', origin: 'https://shop.example.com' },
      payload: JSON.stringify({ events, client: 'test' }),
    });
  const ok = (version: string, loadMs: number) => ({
    module: 'checkout',
    version,
    success: true,
    loadMs,
  });
  const fail = (version: string, error = 'ChunkLoadError: timeout') => ({
    module: 'checkout',
    version,
    success: false,
    error,
  });

  beforeAll(async () => {
    app = await buildApp();
    await app.ready();
    fx = new Fixtures(app);
    const { workspace, module, hostApp } = await fx.workspace();
    ws = workspace.slug;
    workspaceId = workspace.id;
    moduleId = module.id;
    productionId = hostApp.Environments.find((e) => e.slug === 'production')!.id;
    const owner = await fx.user();
    await fx.member(workspace.id, owner.id, 'owner');
    token = await fx.session(owner);

    const deploy = (version: string, extra = {}) =>
      api('POST', `/api/workspaces/${ws}/modules/checkout/deploy`, {
        environment: 'production',
        url: `https://cdn.example.com/checkout/${version}.js`,
        version,
        integrity: 'sha384-abc',
        ...extra,
      });
    expect((await deploy('1.0.0')).statusCode).toBe(201);
    expect((await deploy('2.0.0', { canary: { trafficPercent: 10 } })).statusCode).toBe(201);
  });

  afterAll(async () => {
    await fx.cleanup();
    await app.close();
  });

  it('accepts reports for live versions only, from any origin', async () => {
    const res = await report([
      ...Array.from({ length: 10 }, (_, i) => ok('1.0.0', (i + 1) * 100)),
      ok('2.0.0', 300),
      fail('2.0.0'),
      fail('2.0.0'),
      fail('2.0.0', 'TypeError: x is undefined'),
      ok('0.9.0', 100), // not live
      { module: 'unknown', version: '1.0.0', success: true },
    ]);
    expect(res.statusCode).toBe(202);
    expect(res.json()).toEqual({ accepted: 14, rejected: 2 });
    expect(res.headers['access-control-allow-origin']).toBe('*');

    // The variant comes from the version, not from anything the client claims.
    const stored = await app.container.systemDb.moduleHealthEvent.groupBy({
      by: ['variant'],
      where: { remoteModuleId: moduleId },
      _count: true,
    });
    expect(Object.fromEntries(stored.map((s) => [s.variant, s._count]))).toEqual({
      stable: 10,
      canary: 4,
    });
  });

  it('rejects malformed reports', async () => {
    const raw = (payload: string, env = 'production') =>
      app.inject({
        method: 'POST',
        url: `/api/health/${ws}/portal/${env}`,
        headers: { 'content-type': 'text/plain' },
        payload,
      });
    expect((await raw('not json')).statusCode).toBe(400);
    expect((await raw(JSON.stringify({ events: [] }))).statusCode).toBe(400);
    const tooMany = Array.from({ length: 51 }, () => ok('1.0.0', 1));
    expect((await raw(JSON.stringify({ events: tooMany }))).statusCode).toBe(400);
    expect((await report([ok('1.0.0', 1)], 'nope')).statusCode).toBe(404);
  });

  it('picks up a version deployed after the live-version cache was filled', async () => {
    await new Promise((r) => setTimeout(r, 2_100));
    const deployed = await api('POST', `/api/workspaces/${ws}/modules/checkout/deploy`, {
      environment: 'production',
      url: 'https://cdn.example.com/checkout/2.1.0.js',
      version: '2.1.0',
      integrity: 'sha384-abc',
      canary: { trafficPercent: 10 },
    });
    expect(deployed.statusCode).toBe(201);
    const res = await report([fail('2.1.0')]);
    expect(res.json()).toEqual({ accepted: 1, rejected: 0 });
  });

  it('aggregates the last 5 minutes per variant (HLT-02/03)', async () => {
    const res = await api(
      'GET',
      `/api/workspaces/${ws}/modules/checkout/health?environment=production`
    );
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toMatchObject({
      module: 'checkout',
      environment: 'production',
      windowMinutes: 5,
      sampleCount: 15,
      errorCount: 4,
    });
    expect(body.loadSuccessRate).toBeCloseTo(11 / 15);
    expect(body.variants.stable).toEqual({
      sampleCount: 10,
      errorCount: 0,
      loadSuccessRate: 1,
      p50LoadMs: 550,
      p95LoadMs: 955,
    });
    expect(body.variants.canary).toMatchObject({ sampleCount: 5, errorCount: 4, p50LoadMs: 300 });
    expect(body.variants.canary.loadSuccessRate).toBeCloseTo(0.2);
    expect(body.topErrors[0]).toEqual({
      message: 'ChunkLoadError: timeout',
      variant: 'canary',
      count: 3,
    });
  });

  it('reports a degrading trend against the previous window', async () => {
    // 20 clean loads six minutes ago: the previous window was healthy.
    const sixMinutesAgo = new Date(Date.now() - 6 * 60_000);
    await app.container.systemDb.moduleHealthEvent.createMany({
      data: Array.from({ length: 20 }, () => ({
        workspaceId,
        remoteModuleId: moduleId,
        environmentId: productionId,
        variant: 'stable',
        version: '1.0.0',
        success: true,
        loadMs: 100,
        reportedAt: sixMinutesAgo,
      })),
    });
    const res = await api(
      'GET',
      `/api/workspaces/${ws}/modules/checkout/health?environment=production`
    );
    expect(res.json().trend).toBe('degrading');

    const stats = (n: number, errors: number) => ({
      sampleCount: n,
      errorCount: errors,
      loadSuccessRate: n ? (n - errors) / n : null,
      p50LoadMs: null,
      p95LoadMs: null,
    });
    expect(trendOf(stats(5, 0), stats(50, 10))).toBe('insufficient_data');
    expect(trendOf(stats(50, 0), stats(50, 10))).toBe('improving');
    expect(trendOf(stats(100, 1), stats(100, 1))).toBe('steady');
  });

  it('rolls events up into hourly series for sparklines (HLT-04)', async () => {
    await rollUpHealth(app.container.systemDb, new Date(Date.now() - 2 * 3_600_000));
    // Idempotent: a second run rewrites the same rows.
    await rollUpHealth(app.container.systemDb, new Date(Date.now() - 2 * 3_600_000));

    const res = await api('GET', `/api/workspaces/${ws}/health`);
    expect(res.statusCode).toBe(200);
    const series = res
      .json()
      .series.find((s: { moduleId: string; environment: string }) => s.moduleId === moduleId);
    expect(series.environment).toBe('production');
    const total = series.hourly.reduce(
      (sum: number, p: { sampleCount: number }) => sum + p.sampleCount,
      0
    );
    expect(total).toBe(35);

    const detail = await api(
      'GET',
      `/api/workspaces/${ws}/modules/checkout/health?environment=production`
    );
    expect(
      detail.json().hourly.reduce((sum: number, p: { errorCount: number }) => sum + p.errorCount, 0)
    ).toBe(4);
  });
});
