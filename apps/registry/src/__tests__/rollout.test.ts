// Copyright The Harmoniq Authors
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { FastifyInstance } from 'fastify';
import { buildApp } from '../app';
import { checkGate, evaluateRollouts, RolloutDeps } from '../services/rollout';
import { Fixtures, bearer } from './helpers/fixtures';

describe('Staged rollouts (M3.5)', () => {
  let app: FastifyInstance;
  let fx: Fixtures;
  let ws: string;
  let workspaceId: string;
  let moduleId: string;
  let productionId: string;
  let token: string;
  let deps: RolloutDeps;

  const api = (method: 'GET' | 'POST' | 'PUT', url: string, payload?: object) =>
    app.inject({ method, url, payload, headers: bearer(token) });
  const rollout = {
    bands: [
      { percent: 5, holdMinutes: 10 },
      { percent: 25, holdMinutes: 10 },
      { percent: 100, holdMinutes: 0 },
    ],
    gate: { maxErrorRate: 0.1, minSamples: 5 },
  };
  const deploy = (version: string, canary?: object) =>
    api('POST', `/api/workspaces/${ws}/modules/checkout/deploy`, {
      environment: 'production',
      url: `https://cdn.example.com/checkout/${version}.js`,
      version,
      integrity: 'sha384-abc',
      ...(canary && { canary }),
    });
  const canaryRow = () =>
    app.container.systemDb.moduleVersion.findFirst({
      where: { remoteModuleId: moduleId, environmentId: productionId, status: 'canary' },
    });
  const loads = (version: string, ok: number, failed: number) =>
    app.container.systemDb.moduleHealthEvent.createMany({
      data: [...Array(ok).fill(true), ...Array(failed).fill(false)].map((success) => ({
        workspaceId,
        remoteModuleId: moduleId,
        environmentId: productionId,
        variant: 'canary',
        version,
        success,
        loadMs: 100,
      })),
    });
  /** Runs the job as if `minutes` had passed; returns the outcome for this module. */
  const tick = async (minutes: number) => {
    const canary = await canaryRow();
    const results = await evaluateRollouts(deps, new Date(Date.now() + minutes * 60_000));
    return results.find((r) => r.versionId === canary?.id)?.outcome ?? 'none';
  };
  const lastAudit = (action: string) =>
    app.container.systemDb.auditEvent.findFirst({
      where: { workspaceId, action },
      orderBy: { createdAt: 'desc' },
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
    const { systemDb, withTenant, mutations, webhooks, logger } = app.container;
    deps = { systemDb, withTenant, mutations, webhooks, logger };
    expect((await deploy('1.0.0')).statusCode).toBe(201);
  });

  afterAll(async () => {
    await fx.cleanup();
    await app.close();
  });

  it('validates schedules', async () => {
    const bad = async (bands: object[]) =>
      (await deploy('9.9.9', { rollout: { bands } })).statusCode;
    expect(
      await bad([
        { percent: 50, holdMinutes: 5 },
        { percent: 10, holdMinutes: 5 },
      ])
    ).toBe(400);
    expect(
      await bad([
        { percent: 10, holdMinutes: 5 },
        { percent: 50, holdMinutes: 5 },
      ])
    ).toBe(400);
    expect((await deploy('9.9.9', { trafficPercent: 5, rollout })).statusCode).toBe(400);

    const stats = (n: number, errors: number, p95: number | null = null) => ({
      sampleCount: n,
      errorCount: errors,
      loadSuccessRate: n ? (n - errors) / n : null,
      p50LoadMs: null,
      p95LoadMs: p95,
    });
    const gate = { minSamples: 10, maxErrorRateDelta: 0.05, maxP95Ms: 500 };
    expect(checkGate(gate, stats(5, 0), stats(100, 0)).verdict).toBe('wait');
    expect(checkGate(gate, stats(100, 2, 400), stats(100, 1)).verdict).toBe('pass');
    const failed = checkGate(gate, stats(100, 10, 900), stats(100, 1));
    expect(failed.verdict).toBe('fail');
    expect(failed.verdict === 'fail' && failed.reasons).toHaveLength(2);
  });

  it('starts at the first band, holds, waits for samples, then advances', async () => {
    const res = await deploy('2.0.0', { rollout });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({
      status: 'canary',
      trafficPercent: 5,
      rollout: { currentBandIndex: 0, bands: rollout.bands },
    });

    expect(await tick(5)).toBe('none'); // still holding
    expect(await tick(11)).toBe('waiting_for_samples');

    await loads('2.0.0', 10, 0);
    expect(await tick(11)).toBe('advanced');
    expect(await canaryRow()).toMatchObject({ trafficPercent: 25, currentBandIndex: 1 });
    const audit = await lastAudit('canary.rollout_advance');
    expect(audit).toMatchObject({ actorType: 'system', actorId: 'system:rollout' });
    expect(audit!.metadata).toMatchObject({ trafficPercent: 25, band: 2, manual: false });

    // The next band's clock started over.
    expect(await tick(5)).toBe('none');
  });

  it('can be advanced by hand; the 100% band promotes', async () => {
    const res = await api('POST', `/api/workspaces/${ws}/modules/checkout/canary/advance`, {
      environment: 'production',
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ version: '2.0.0', status: 'active', rollout: null });
    expect(await canaryRow()).toBeNull();
    const manifest = await app.inject({
      method: 'GET',
      url: `/api/manifest/${ws}/portal/production`,
    });
    expect(manifest.json().modules[0].version).toBe('2.0.0');
    expect((await lastAudit('canary.promote'))!.metadata).toMatchObject({
      rollout: true,
      manual: true,
    });
  });

  it('aborts when the gate fails', async () => {
    const dispatch = vi.spyOn(app.container.webhooks, 'dispatch');
    await deploy('3.0.0', { rollout });
    await loads('3.0.0', 8, 4); // 33% errors > 10%
    expect(await tick(11)).toBe('aborted');
    expect(await canaryRow()).toBeNull();
    const audit = await lastAudit('canary.rollout_failed');
    expect(audit).toMatchObject({ actorType: 'system' });
    expect((audit!.metadata as { reasons: string[] }).reasons[0]).toMatch(/error rate/);
    expect(dispatch.mock.calls.some((c) => c[1] === 'canary.auto_rolled_back')).toBe(true);
    dispatch.mockRestore();
  });

  it('stops following the schedule once traffic is set by hand', async () => {
    await deploy('4.0.0', { rollout });
    await api('PUT', `/api/workspaces/${ws}/modules/checkout/canary`, {
      environment: 'production',
      trafficPercent: 40,
    });
    expect(await canaryRow()).toMatchObject({
      trafficPercent: 40,
      currentBandIndex: null,
      rolloutSchedule: null,
    });
    expect(await tick(60)).toBe('none');
    const advance = await api('POST', `/api/workspaces/${ws}/modules/checkout/canary/advance`, {
      environment: 'production',
    });
    expect(advance.statusCode).toBe(409);
  });

  it('pauses while the environment is frozen', async () => {
    await deploy('5.0.0', { rollout });
    await loads('5.0.0', 10, 0);
    await api('PUT', `/api/workspaces/${ws}/host-apps/portal/environments/production/freeze`, {
      reason: 'release day',
    });
    expect(await tick(11)).toMatch(/frozen/);
    expect(await canaryRow()).toMatchObject({ version: '5.0.0', trafficPercent: 5 });
  });
});
