import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { FastifyInstance } from 'fastify';
import { buildApp } from '../app';
import { Fixtures, bearer } from './helpers/fixtures';

describe('Module ownership (M4.1, RBAC-01..06)', () => {
  let app: FastifyInstance;
  let fx: Fixtures;
  let ws: string;
  let workspaceId: string;
  let admin: string;
  let alice: string; // developer, will own checkout
  let bob: string; // developer, owns nothing
  let aliceMemberId: string;

  const api = (as: string, method: 'GET' | 'POST' | 'PUT', url: string, payload?: object) =>
    app.inject({ method, url, payload, headers: bearer(as) });
  const deploy = (as: string, module: string, version: string) =>
    api(as, 'POST', `/api/workspaces/${ws}/modules/${module}/deploy`, {
      environment: 'production',
      url: `https://cdn.example.com/${module}/${version}.js`,
      version,
      integrity: 'sha384-abc',
    });

  beforeAll(async () => {
    app = await buildApp();
    await app.ready();
    fx = new Fixtures(app);
    const { workspace, hostApp } = await fx.workspace();
    ws = workspace.slug;
    workspaceId = workspace.id;
    await fx.module(workspace.id, hostApp.id, 'cart');
    const users = await Promise.all([fx.user(), fx.user(), fx.user()]);
    await fx.member(workspace.id, users[0].id, 'admin');
    aliceMemberId = (await fx.member(workspace.id, users[1].id, 'developer')).id;
    await fx.member(workspace.id, users[2].id, 'developer');
    [admin, alice, bob] = await Promise.all(users.map((u) => fx.session(u)));
  });

  afterAll(async () => {
    await fx.cleanup();
    await app.close();
  });

  it('lets every developer change a module without owners (RBAC-03)', async () => {
    expect((await deploy(bob, 'checkout', '1.0.0')).statusCode).toBe(201);
    const detail = (await api(bob, 'GET', `/api/workspaces/${ws}/modules/checkout`)).json();
    expect(detail).toMatchObject({ owners: [], canWrite: true });
  });

  it('only admins set owners', async () => {
    const asDev = await api(alice, 'PUT', `/api/workspaces/${ws}/modules/checkout/owners`, {
      memberIds: [aliceMemberId],
    });
    expect(asDev.statusCode).toBe(403);
    const unknown = await api(admin, 'PUT', `/api/workspaces/${ws}/modules/checkout/owners`, {
      memberIds: ['nope'],
    });
    expect(unknown.statusCode).toBe(400);
    const res = await api(admin, 'PUT', `/api/workspaces/${ws}/modules/checkout/owners`, {
      memberIds: [aliceMemberId],
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().owners).toEqual([expect.objectContaining({ memberId: aliceMemberId })]);
  });

  it('restricts an owned module to its owners and admins (RBAC-02)', async () => {
    expect((await deploy(alice, 'checkout', '1.1.0')).statusCode).toBe(201);
    expect((await deploy(admin, 'checkout', '1.2.0')).statusCode).toBe(201);
    // Other modules stay open to developers.
    expect((await deploy(bob, 'cart', '1.0.0')).statusCode).toBe(201);

    const denied = await deploy(bob, 'checkout', '9.9.9');
    expect(denied.statusCode).toBe(403);
    expect(denied.json().error.message).toContain('owners of "checkout"');
    for (const res of [
      await api(bob, 'POST', `/api/workspaces/${ws}/modules/checkout/rollback`, {
        environment: 'production',
        previous: true,
      }),
      await api(bob, 'PUT', `/api/workspaces/${ws}/modules/checkout/kill-switch`, {
        environment: 'production',
        disabled: true,
        reason: 'not mine',
      }),
      await api(bob, 'POST', `/api/workspaces/${ws}/scheduled-operations`, {
        runAt: new Date(Date.now() + 600_000).toISOString(),
        operation: {
          type: 'rollback',
          module: 'checkout',
          request: { environment: 'production', previous: true },
        },
      }),
    ]) {
      expect(res.statusCode).toBe(403);
    }
    // Reading is still allowed, and the dashboard learns not to offer actions.
    const detail = (await api(bob, 'GET', `/api/workspaces/${ws}/modules/checkout`)).json();
    expect(detail.canWrite).toBe(false);
    expect(
      (await api(alice, 'GET', `/api/workspaces/${ws}/modules/checkout`)).json().canWrite
    ).toBe(true);
  });

  it('audits refused attempts (RBAC-06)', async () => {
    const attempts = await app.container.systemDb.auditEvent.findMany({
      where: { workspaceId, action: 'module.unauthorized_attempt' },
    });
    expect(attempts.length).toBeGreaterThanOrEqual(3);
    expect(attempts[0].metadata).toMatchObject({ module: 'checkout', method: 'POST' });
  });

  it('keeps API keys working within their module scope (RBAC-04)', async () => {
    const { raw } = await fx.apiKey(workspaceId, { scopes: ['deploy:write'] });
    expect((await deploy(raw, 'checkout', '2.0.0')).statusCode).toBe(201);
    const { raw: readOnly } = await fx.apiKey(workspaceId, { scopes: ['manifest:read'] });
    const detail = (await api(readOnly, 'GET', `/api/workspaces/${ws}/modules/checkout`)).json();
    expect(detail.canWrite).toBe(false);
  });
});
