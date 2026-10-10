import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { FastifyInstance } from 'fastify';
import { buildApp } from '../app';
import { Fixtures, bearer } from './helpers/fixtures';

describe('Instance administration (M4.8, INST-05..10, 18)', () => {
  let app: FastifyInstance;
  let fx: Fixtures;
  let root: string; // instance admin
  let rootId: string;
  let plain: string; // signed-in user, not an admin
  let owner: string;
  let ownerUser: { id: string; email: string };
  let ws: string;
  let key: string;

  const api = (
    as: string | null,
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
    url: string,
    payload?: object
  ) => app.inject({ method, url, payload, headers: as ? bearer(as) : {} });
  const deploy = (version: string) =>
    api(key, 'POST', `/api/workspaces/${ws}/modules/checkout/deploy`, {
      environment: 'production',
      url: `https://cdn.example.com/checkout/${version}.js`,
      version,
      integrity: 'sha384-abc',
    });

  beforeAll(async () => {
    app = await buildApp();
    await app.ready();
    fx = new Fixtures(app);
    const [r, p, o] = await Promise.all([fx.user({ instanceAdmin: true }), fx.user(), fx.user()]);
    rootId = r.id;
    ownerUser = o;
    [root, plain, owner] = await Promise.all([r, p, o].map((u) => fx.session(u)));
    const { workspace } = await fx.workspace();
    ws = workspace.slug;
    await fx.member(workspace.id, o.id, 'owner');
    key = (await fx.apiKey(workspace.id)).raw;
  });

  afterAll(async () => {
    await fx.cleanup();
    await app.close();
  });

  it('is for instance admins only (INST-05/06)', async () => {
    for (const url of ['/api/admin/workspaces', '/api/admin/users', '/api/admin/admins']) {
      expect((await api(plain, 'GET', url)).statusCode).toBe(403);
      expect((await api(owner, 'GET', url)).statusCode).toBe(403); // workspace owners too
      expect((await api(null, 'GET', url)).statusCode).toBe(401);
      expect((await api(root, 'GET', url)).statusCode).toBe(200);
    }
  });

  it('suspends a workspace: reads and manifests work, changes are refused (INST-09)', async () => {
    expect((await deploy('1.0.0')).statusCode).toBe(201);
    const listed = (await api(root, 'GET', `/api/admin/workspaces?query=${ws}`)).json();
    expect(listed.workspaces[0]).toMatchObject({ slug: ws, modules: 1, members: 1, deploys: 1 });

    const suspended = await api(root, 'POST', `/api/admin/workspaces/${ws}/suspend`, {
      reason: 'Unpaid invoice',
    });
    expect(suspended.statusCode).toBe(200);
    const refused = await deploy('1.1.0');
    expect(refused.statusCode).toBe(403);
    expect(refused.json().error.code).toBe('WORKSPACE_SUSPENDED');
    const ownerWrite = await api(owner, 'PATCH', `/api/workspaces/${ws}`, { name: 'Renamed' });
    expect(ownerWrite.json().error.code).toBe('WORKSPACE_SUSPENDED');
    expect((await api(owner, 'GET', `/api/workspaces/${ws}/modules`)).statusCode).toBe(200);
    expect((await api(owner, 'GET', `/api/workspaces/${ws}`)).json()).toMatchObject({
      suspendedReason: 'Unpaid invoice',
    });
    const manifest = await api(null, 'GET', `/api/manifest/${ws}/portal/production`);
    expect(manifest.statusCode).toBe(200);
    expect(manifest.json().modules[0]).toMatchObject({ name: 'checkout', version: '1.0.0' });

    await api(root, 'POST', `/api/admin/workspaces/${ws}/unsuspend`);
    expect((await deploy('1.1.0')).statusCode).toBe(201);
  });

  it('manages users: sessions, deletion guarded by ownership (INST-10)', async () => {
    const found = (await api(root, 'GET', `/api/admin/users?query=${ownerUser.email}`)).json();
    expect(found.users).toHaveLength(1);
    expect(found.users[0]).toMatchObject({
      email: ownerUser.email,
      isInstanceAdmin: false,
      workspaces: [{ slug: ws, role: 'owner' }],
    });

    const db = app.container.systemDb;
    await db.refreshToken.create({
      data: {
        userId: ownerUser.id,
        tokenHash: `admin-${Date.now()}`,
        familyId: 'f',
        expiresAt: new Date(Date.now() + 3_600_000),
      },
    });
    const revoked = await api(root, 'POST', `/api/admin/users/${ownerUser.id}/revoke-sessions`);
    expect(revoked.json().revoked).toBe(1);
    expect(await db.refreshToken.count({ where: { userId: ownerUser.id, revokedAt: null } })).toBe(
      0
    );

    const url = `/api/admin/users/${ownerUser.id}`;
    expect((await api(root, 'DELETE', url)).statusCode).toBe(400); // no confirmation
    const lastOwner = await api(root, 'DELETE', `${url}?confirm=${ownerUser.email}`);
    expect(lastOwner.statusCode).toBe(409);
    expect(lastOwner.json().error.message).toContain(ws);
    expect((await api(root, 'DELETE', `/api/admin/users/${rootId}?confirm=x`)).statusCode).toBe(
      400
    );

    // Another owner takes over; the user can now be erased.
    const other = await fx.user();
    const workspace = await db.workspace.findUniqueOrThrow({ where: { slug: ws } });
    await fx.member(workspace.id, other.id, 'owner');
    expect((await api(root, 'DELETE', `${url}?confirm=${ownerUser.email}`)).statusCode).toBe(204);
    expect(await db.user.findUnique({ where: { id: ownerUser.id } })).toBeNull();
    expect(await db.workspaceMember.count({ where: { userId: ownerUser.id } })).toBe(0);
  });

  it('grants and revokes instance admin (INST-07)', async () => {
    const u = await fx.user();
    expect(
      (await api(root, 'POST', '/api/admin/admins', { email: 'nobody@x.test' })).statusCode
    ).toBe(404);
    expect((await api(root, 'POST', '/api/admin/admins', { email: u.email })).statusCode).toBe(201);
    const session = await fx.session(u);
    expect((await api(session, 'GET', '/api/admin/users')).statusCode).toBe(200);
    const admins = (await api(root, 'GET', '/api/admin/admins')).json().admins;
    expect(admins.map((a: { email: string }) => a.email)).toContain(u.email);
    expect((await api(root, 'DELETE', `/api/admin/admins/${u.id}`)).statusCode).toBe(204);
    expect((await api(session, 'GET', '/api/admin/users')).statusCode).toBe(403);
  });

  it('records instance changes, never secrets (INST-18)', async () => {
    const events = (await api(root, 'GET', '/api/admin/audit')).json().events as {
      action: string;
      actorId: string;
      metadata: unknown;
    }[];
    const mine = events.filter((e) => e.actorId === rootId).map((e) => e.action);
    expect(mine).toEqual(
      expect.arrayContaining([
        'instance.workspace_suspend',
        'instance.workspace_unsuspend',
        'instance.user_sessions_revoke',
        'instance.user_delete',
        'instance.admin_grant',
        'instance.admin_revoke',
      ])
    );
    const deletion = events.find((e) => e.action === 'instance.user_delete');
    expect(JSON.stringify(deletion)).not.toContain(ownerUser.email);
  });

  it('hard-deletes a workspace with confirmation (INST-09)', async () => {
    const { workspace } = await fx.workspace();
    const url = `/api/admin/workspaces/${workspace.slug}`;
    expect((await api(root, 'DELETE', url)).statusCode).toBe(400);
    expect((await api(root, 'DELETE', `${url}?confirm=${workspace.slug}`)).statusCode).toBe(204);
    expect(
      await app.container.systemDb.workspace.findUnique({ where: { id: workspace.id } })
    ).toBeNull();
  });
});
