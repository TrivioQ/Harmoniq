import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { FastifyInstance } from 'fastify';
import { buildApp } from '../app';
import { runScheduled } from '../services/scheduler';
import { Fixtures, bearer } from './helpers/fixtures';

describe('Scheduled operations (M3.6)', () => {
  let app: FastifyInstance;
  let fx: Fixtures;
  let ws: string;
  let workspaceId: string;
  let ownerId: string;
  let token: string;

  const api = (
    method: 'GET' | 'POST' | 'PUT' | 'DELETE',
    url: string,
    payload?: object,
    as = token
  ) => app.inject({ method, url, payload, headers: bearer(as) });
  const inMinutes = (m: number) => new Date(Date.now() + m * 60_000).toISOString();
  const schedule = (operation: object, runAt = inMinutes(5), as = token) =>
    api('POST', `/api/workspaces/${ws}/scheduled-operations`, { runAt, operation }, as);
  const deployOp = (version: string) => ({
    type: 'deploy',
    module: 'checkout',
    request: {
      environment: 'production',
      url: `https://cdn.example.com/checkout/${version}.js`,
      version,
      integrity: 'sha384-abc',
    },
  });
  /** Runs the job as if `minutes` had passed; returns this workspace's outcomes. */
  const run = async (minutes: number) => {
    const results = await runScheduled(app, new Date(Date.now() + minutes * 60_000));
    const ids = new Set(
      (await app.container.systemDb.scheduledOperation.findMany({ where: { workspaceId } })).map(
        (o) => o.id
      )
    );
    return results.filter((r) => ids.has(r.id));
  };
  const active = async () =>
    (await app.inject({ method: 'GET', url: `/api/manifest/${ws}/portal/production` })).json()
      .modules[0]?.version;

  beforeAll(async () => {
    app = await buildApp();
    await app.ready();
    fx = new Fixtures(app);
    const { workspace } = await fx.workspace();
    ws = workspace.slug;
    workspaceId = workspace.id;
    const owner = await fx.user();
    ownerId = owner.id;
    await fx.member(workspace.id, owner.id, 'owner');
    token = await fx.session(owner);
  });

  afterAll(async () => {
    await fx.cleanup();
    await app.close();
  });

  it('validates when scheduling', async () => {
    expect((await schedule(deployOp('1.0.0'), inMinutes(-5))).statusCode).toBe(400);
    expect((await schedule(deployOp('1.0.0'), inMinutes(60 * 24 * 400))).statusCode).toBe(400);
    const noUrl = { ...deployOp('1.0.0'), request: { environment: 'production', version: '1' } };
    expect((await schedule(noUrl)).statusCode).toBe(400);
    expect((await schedule({ ...deployOp('1.0.0'), module: 'nope' })).statusCode).toBe(404);
  });

  it('runs a deploy at its time, as its creator', async () => {
    const created = await schedule(deployOp('1.0.0'));
    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({
      type: 'deploy',
      module: 'checkout',
      environment: 'production',
      status: 'pending',
      createdBy: { type: 'user', id: ownerId },
    });

    expect(await run(1)).toEqual([]); // not due yet
    const [result] = await run(6);
    expect(result).toMatchObject({ id: created.json().id, status: 'done', statusCode: 201 });
    expect(await active()).toBe('1.0.0');

    const deployAudit = await app.container.systemDb.auditEvent.findFirst({
      where: { workspaceId, action: 'module.deploy' },
    });
    expect(deployAudit).toMatchObject({ actorType: 'user', actorId: ownerId });
    const listed = (await api('GET', `/api/workspaces/${ws}/scheduled-operations`)).json()
      .operations[0];
    expect(listed).toMatchObject({ status: 'done', result: { statusCode: 201 } });
    expect(await run(7)).toEqual([]); // ran once
  });

  it('cancels pending operations only', async () => {
    const id = (await schedule(deployOp('9.0.0'))).json().id;
    const cancel = () => api('DELETE', `/api/workspaces/${ws}/scheduled-operations/${id}`);
    expect((await cancel()).json().status).toBe('cancelled');
    expect((await cancel()).statusCode).toBe(409);
    expect(await run(10)).toEqual([]);
    expect(await active()).toBe('1.0.0');
  });

  it('records failures, e.g. a frozen environment', async () => {
    await schedule({
      type: 'kill_switch',
      module: 'checkout',
      request: { environment: 'production', disabled: true, reason: 'maintenance window' },
    });
    await schedule(deployOp('2.0.0'));
    await api('PUT', `/api/workspaces/${ws}/host-apps/portal/environments/production/freeze`, {
      reason: 'release day',
    });
    const results = await run(6);
    // The kill switch works when frozen; the deploy doesn't.
    expect(results.map((r) => r.status).sort()).toEqual(['done', 'failed']);
    expect(results.find((r) => r.status === 'failed')!.error).toMatch(/frozen/);
    await api('DELETE', `/api/workspaces/${ws}/host-apps/portal/environments/production/freeze`);
  });

  it('re-checks access when it runs', async () => {
    const dev = await fx.user();
    const member = await fx.member(workspaceId, dev.id, 'developer');
    const devToken = await fx.session(dev);
    expect((await schedule(deployOp('3.0.0'), inMinutes(5), devToken)).statusCode).toBe(201);
    await app.container.systemDb.workspaceMember.delete({ where: { id: member.id } });
    const [result] = await run(6);
    expect(result.status).toBe('failed');
    expect(await active()).toBe('1.0.0');

    // API keys: module scoping applies when scheduling, revocation when running.
    const { raw: scoped } = await fx.apiKey(workspaceId, {
      scopes: ['deploy:write'],
      moduleIds: ['other'],
    });
    expect((await schedule(deployOp('3.0.0'), inMinutes(5), scoped)).statusCode).toBe(403);
    const { raw: key } = await fx.apiKey(workspaceId, { scopes: ['deploy:write'] });
    const viaKey = await schedule(deployOp('3.1.0'), inMinutes(5), key);
    expect(viaKey.json().createdBy.type).toBe('apiKey');
    await app.container.systemDb.apiKey.update({
      where: { id: viaKey.json().createdBy.id },
      data: { revokedAt: new Date() },
    });
    expect((await run(6))[0]).toMatchObject({ status: 'failed', statusCode: 401 });
  });

  it('never accepts the internal headers from outside the process', async () => {
    const forged = await app.inject({
      method: 'GET',
      url: `/api/workspaces/${ws}/scheduled-operations`,
      headers: { 'x-harmoniq-internal': 'guess', 'x-harmoniq-run-as': `user:${ownerId}` },
    });
    expect(forged.statusCode).toBe(401);
  });
});
