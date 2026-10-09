import { describe, it, expect, beforeAll, afterAll, vi, beforeEach } from 'vitest';
import { FastifyInstance } from 'fastify';
import { buildApp } from '../app';
import { AlertDeps, evaluateRule, isBreach } from '../services/alerts';
import { Fixtures, bearer } from './helpers/fixtures';

describe('Alerts and auto-rollback (M3.4)', () => {
  let app: FastifyInstance;
  let fx: Fixtures;
  let ws: string;
  let workspaceId: string;
  let moduleId: string;
  let productionId: string;
  let token: string;
  let deps: AlertDeps;
  let dispatch: {
    mock: { calls: unknown[][] };
    mockClear(): void;
    mockRestore(): void;
  };

  const api = (
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE' | 'PUT',
    url: string,
    payload?: object,
    as = token
  ) => app.inject({ method, url, payload, headers: bearer(as) });
  const deploy = (version: string, extra = {}) =>
    api('POST', `/api/workspaces/${ws}/modules/checkout/deploy`, {
      environment: 'production',
      url: `https://cdn.example.com/checkout/${version}.js`,
      version,
      integrity: 'sha384-abc',
      ...extra,
    });
  const createRule = (body: object) => api('POST', `/api/workspaces/${ws}/alerts`, body);
  const loads = (variant: 'stable' | 'canary', version: string, ok: number, failed: number) =>
    app.container.systemDb.moduleHealthEvent.createMany({
      data: [...Array(ok).fill(true), ...Array(failed).fill(false)].map((success) => ({
        workspaceId,
        remoteModuleId: moduleId,
        environmentId: productionId,
        variant,
        version,
        success,
        loadMs: 100,
        errorMessage: success ? null : 'ChunkLoadError',
      })),
    });
  const clearLoads = () =>
    app.container.systemDb.moduleHealthEvent.deleteMany({ where: { remoteModuleId: moduleId } });
  const evaluate = async (ruleId: string) => {
    const rule = await app.container.systemDb.alertRule.findUniqueOrThrow({
      where: { id: ruleId },
      include: {
        workspace: { select: { id: true, slug: true } },
        remoteModule: { include: { hostApp: true } },
        environment: true,
      },
    });
    return evaluateRule(deps, rule);
  };
  const active = async () =>
    (await app.inject({ method: 'GET', url: `/api/manifest/${ws}/portal/production` })).json()
      .modules[0]?.version;
  const canaryVersion = async () =>
    (
      await app.container.systemDb.moduleVersion.findFirst({
        where: { remoteModuleId: moduleId, environmentId: productionId, status: 'canary' },
      })
    )?.version ?? null;
  const events = (name: string) =>
    dispatch.mock.calls.filter((c) => c[1] === name).map((c) => c[2] as Record<string, unknown>);

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
  });

  beforeEach(() => {
    dispatch?.mockRestore();
    dispatch = vi.spyOn(app.container.webhooks, 'dispatch') as unknown as typeof dispatch;
  });

  afterAll(async () => {
    await fx.cleanup();
    await app.close();
  });

  it('validates rules and requires admin to write them', async () => {
    expect(
      (
        await createRule({
          name: 'x',
          condition: 'canary_error_rate',
          threshold: 0.1,
          action: 'webhook',
        })
      ).statusCode
    ).toBe(400); // module condition without module/environment
    expect(
      (
        await createRule({
          name: 'x',
          condition: 'webhook_failure_rate',
          threshold: 0.5,
          action: 'auto_rollback',
        })
      ).statusCode
    ).toBe(400);
    expect(
      (
        await createRule({
          name: 'x',
          condition: 'canary_error_rate',
          threshold: 5,
          action: 'webhook',
          module: 'checkout',
          environment: 'production',
        })
      ).statusCode
    ).toBe(400); // rates are fractions

    const dev = await fx.user();
    await fx.member(workspaceId, dev.id, 'developer');
    const devToken = await fx.session(dev);
    const asDev = await api(
      'POST',
      `/api/workspaces/${ws}/alerts`,
      { name: 'x', condition: 'webhook_failure_rate', threshold: 0.5, action: 'webhook' },
      devToken
    );
    expect(asDev.statusCode).toBe(403);
    expect((await api('GET', `/api/workspaces/${ws}/alerts`, undefined, devToken)).statusCode).toBe(
      200
    );
    expect(isBreach('load_success_rate', 0.8, 0.9)).toBe(true);
    expect(isBreach('canary_error_rate', 0.1, 0.2)).toBe(false);
  });

  it('aborts a failing canary once, audits it as system, and notifies', async () => {
    expect((await deploy('1.0.0')).statusCode).toBe(201);
    expect((await deploy('2.0.0', { canary: { trafficPercent: 20 } })).statusCode).toBe(201);
    const created = await createRule({
      name: 'Canary errors',
      condition: 'canary_error_rate',
      threshold: 0.2,
      action: 'auto_rollback',
      module: 'checkout',
      environment: 'production',
      minSamples: 5,
    });
    expect(created.statusCode).toBe(201);
    const ruleId = created.json().id;

    // Too few samples: no decision.
    await loads('canary', '2.0.0', 0, 3);
    expect(await evaluate(ruleId)).toMatchObject({ value: null, breaching: false, state: 'ok' });

    await loads('canary', '2.0.0', 2, 5); // 8/10 failed
    const result = await evaluate(ruleId);
    expect(result).toMatchObject({ value: 0.8, breaching: true, state: 'firing' });
    expect(await canaryVersion()).toBeNull();
    expect(await active()).toBe('1.0.0');

    const audit = await app.container.systemDb.auditEvent.findFirstOrThrow({
      where: { workspaceId, action: 'module.auto_rollback' },
    });
    expect(audit).toMatchObject({ actorType: 'system', actorId: `system:alert:${ruleId}` });
    expect(audit.metadata).toMatchObject({
      ruleId,
      value: 0.8,
      kind: 'canary_aborted',
      version: '2.0.0',
    });
    expect(events('alert.triggered')[0]).toMatchObject({
      value: 0.8,
      module: 'checkout',
      autoRollback: { kind: 'canary_aborted', version: '2.0.0' },
    });
    expect(events('canary.auto_rolled_back')).toHaveLength(1);

    // Still breaching on the next run: no second action.
    dispatch.mockClear();
    expect(await evaluate(ruleId)).toMatchObject({ state: 'firing' });
    expect(events('alert.triggered')).toHaveLength(0);

    // Healthy again: resolved.
    await clearLoads();
    expect(await evaluate(ruleId)).toMatchObject({ state: 'ok' });
    expect(events('alert.resolved')).toHaveLength(1);
    const listed = (await api('GET', `/api/workspaces/${ws}/alerts`)).json().rules[0];
    expect(listed).toMatchObject({ id: ruleId, state: 'ok', module: { slug: 'checkout' } });
    expect(listed.lastTriggeredAt).not.toBeNull();

    // Within the cooldown a new breach doesn't fire.
    await deploy('2.1.0', { canary: { trafficPercent: 20 } });
    await loads('canary', '2.1.0', 0, 10);
    expect(await evaluate(ruleId)).toMatchObject({ breaching: true, state: 'ok' });
    expect(await canaryVersion()).toBe('2.1.0');
    await api('PATCH', `/api/workspaces/${ws}/alerts/${ruleId}`, { cooldownMinutes: 0 });
    expect(await evaluate(ruleId)).toMatchObject({ state: 'firing' });
    expect(await canaryVersion()).toBeNull();

    await api('PATCH', `/api/workspaces/${ws}/alerts/${ruleId}`, { enabled: false });
    await clearLoads();
  });

  it('rolls a degraded module back to the previous version', async () => {
    await deploy('3.0.0');
    expect(await active()).toBe('3.0.0');
    const ruleId = (
      await createRule({
        name: 'Success rate',
        condition: 'load_success_rate',
        threshold: 0.95,
        action: 'auto_rollback',
        module: 'checkout',
        environment: 'production',
        minSamples: 10,
      })
    ).json().id;
    await loads('stable', '3.0.0', 8, 4);
    expect(await evaluate(ruleId)).toMatchObject({ breaching: true, state: 'firing' });
    expect(await active()).toBe('1.0.0');
    const audit = await app.container.systemDb.auditEvent.findFirstOrThrow({
      where: {
        workspaceId,
        action: 'module.auto_rollback',
        metadata: { path: ['kind'], equals: 'rolled_back' },
      },
    });
    expect(audit.metadata).toMatchObject({ fromVersion: '3.0.0', toVersion: '1.0.0' });
    expect(events('module.auto_rolled_back')).toHaveLength(1);
    await api('DELETE', `/api/workspaces/${ws}/alerts/${ruleId}`);
    await clearLoads();
  });

  it('still alerts when a freeze blocks the rollback', async () => {
    await deploy('4.0.0', { canary: { trafficPercent: 10 } });
    const ruleId = (
      await createRule({
        name: 'Canary vs stable',
        condition: 'canary_error_rate_delta',
        threshold: 0.1,
        action: 'auto_rollback',
        module: 'checkout',
        environment: 'production',
        minSamples: 5,
      })
    ).json().id;
    await api('PUT', `/api/workspaces/${ws}/host-apps/portal/environments/production/freeze`, {
      reason: 'release day',
    });
    await loads('stable', '1.0.0', 10, 0);
    await loads('canary', '4.0.0', 5, 5);
    expect(await evaluate(ruleId)).toMatchObject({ breaching: true, state: 'firing' });
    expect(await canaryVersion()).toBe('4.0.0');
    expect(events('alert.triggered')[0].autoRollbackError).toMatch(/frozen/);
    const listed = (await api('GET', `/api/workspaces/${ws}/alerts`)).json();
    expect(listed.rules.find((r: { id: string }) => r.id === ruleId).lastError).toMatch(/frozen/);
  });
});
