// Copyright The Harmoniq Authors
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'crypto';
import { FastifyInstance } from 'fastify';
import { buildApp } from '../app';
import { Fixtures, bearer } from './helpers/fixtures';

// IaC-01/02: what the Terraform provider needs — an org key managing workspaces, and a
// full create/read/update/delete lifecycle for host apps, environments and modules.
describe('Infrastructure-as-code lifecycle (IaC-01/02)', () => {
  let app: FastifyInstance;
  let fx: Fixtures;
  let alice: string;
  let key: string;
  const org = `iac-${randomUUID().slice(0, 8)}`;
  const ws = `${org}-ws`;

  const api = (
    as: string,
    method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
    url: string,
    payload?: object
  ) => app.inject({ method, url, payload, headers: bearer(as) });
  const W = `/api/workspaces/${ws}`;

  beforeAll(async () => {
    app = await buildApp();
    await app.ready();
    fx = new Fixtures(app);
    alice = await fx.session(await fx.user());
    expect((await api(alice, 'POST', '/api/orgs', { name: 'IaC', slug: org })).statusCode).toBe(
      201
    );
    key = (
      await api(alice, 'POST', `/api/orgs/${org}/keys`, { name: 'tf', scopes: ['admin'] })
    ).json().key;
  });

  afterAll(async () => {
    const db = app.container.systemDb;
    await db.workspace.deleteMany({ where: { organization: { slug: org } } });
    await db.organization.deleteMany({ where: { slug: org } });
    await fx.cleanup();
    await app.close();
  });

  it('lets an admin org key create workspaces in its org, ownerless', async () => {
    const res = await api(key, 'POST', `/api/orgs/${org}/workspaces`, { name: 'Shop', slug: ws });
    expect(res.statusCode).toBe(201);
    const db = app.container.systemDb;
    const workspace = await db.workspace.findUniqueOrThrow({ where: { slug: ws } });
    expect(await db.workspaceMember.count({ where: { workspaceId: workspace.id } })).toBe(0);
    expect(
      await db.auditEvent.findFirst({
        where: { workspaceId: workspace.id, action: 'workspace.create' },
      })
    ).toMatchObject({ actorType: 'apiKey' });
    expect((await api(key, 'GET', W)).json().hostApps[0].slug).toBe('default');
    // Org admins administer it.
    expect((await api(alice, 'GET', W)).statusCode).toBe(200);
  });

  it('refuses keys that are scoped down or lack the admin scope', async () => {
    const limited = (
      await api(alice, 'POST', `/api/orgs/${org}/keys`, {
        name: 'one',
        scopes: ['admin'],
        workspaces: [ws],
      })
    ).json().key;
    const deployer = (
      await api(alice, 'POST', `/api/orgs/${org}/keys`, { name: 'ci', scopes: ['deploy:write'] })
    ).json().key;
    for (const k of [limited, deployer]) {
      const res = await api(k, 'POST', `/api/orgs/${org}/workspaces`, {
        name: 'X',
        slug: `${ws}-x`,
      });
      expect(res.statusCode).toBe(403);
    }
    // Other org routes stay for users.
    expect((await api(key, 'GET', `/api/orgs/${org}/members`)).statusCode).toBe(403);
  });

  it('updates environments and refuses deleting what still serves versions', async () => {
    expect(
      (
        await api(key, 'POST', `${W}/host-apps`, {
          name: 'Shop',
          slug: 'shop',
          environments: ['staging', 'production'],
        })
      ).statusCode
    ).toBe(201);
    const patched = await api(key, 'PATCH', `${W}/host-apps/shop/environments/production`, {
      name: 'Prod',
      isDefault: true,
    });
    expect(patched.json()).toEqual({ slug: 'production', name: 'Prod', isDefault: true });
    const envs = (await api(key, 'GET', W))
      .json()
      .hostApps.find((h: { slug: string }) => h.slug === 'shop').environments;
    expect(envs.filter((e: { isDefault: boolean }) => e.isDefault)).toHaveLength(1);

    const created = await api(key, 'POST', `${W}/modules`, {
      hostApp: 'shop',
      slug: 'cart',
      name: 'Cart',
    });
    expect(created.statusCode).toBe(201);
    const deployed = await api(key, 'POST', `${W}/modules/${created.json().id}/deploy`, {
      environment: 'production',
      url: 'https://cdn.example.com/cart/1.0.0.js',
      version: '1.0.0',
      integrity: 'sha384-abc',
    });
    expect(deployed.statusCode).toBe(201);

    expect((await api(key, 'DELETE', `${W}/modules/${created.json().id}`)).statusCode).toBe(409);
    expect(
      (await api(key, 'DELETE', `${W}/host-apps/shop/environments/production`)).statusCode
    ).toBe(409);
    expect((await api(key, 'DELETE', `${W}/host-apps/shop`)).statusCode).toBe(409);

    // Nothing live any more (as after rolling everything back).
    await app.container.systemDb.moduleVersion.updateMany({
      where: { remoteModuleId: created.json().id },
      data: { status: 'inactive' },
    });
    expect((await api(key, 'DELETE', `${W}/modules/${created.json().id}`)).statusCode).toBe(204);
    expect((await api(key, 'GET', `${W}/modules/${created.json().id}`)).statusCode).toBe(404);
    expect(
      (await api(key, 'DELETE', `${W}/host-apps/shop/environments/production`)).statusCode
    ).toBe(204);
    expect(
      (await api(key, 'DELETE', `${W}/host-apps/shop/environments/production`)).statusCode
    ).toBe(404);
  });

  it('issues workspace API keys with the org key, never wider than itself', async () => {
    const created = await api(key, 'POST', `${W}/api-keys`, {
      name: 'ci',
      scopes: ['deploy:write'],
    });
    expect(created.statusCode).toBe(201);
    const record = await app.container.systemDb.apiKey.findUniqueOrThrow({
      where: { id: created.json().id },
    });
    expect(record).toMatchObject({ createdBy: null, createdByKeyId: expect.any(String) });
    // Workspace keys still can't mint keys, not even admin ones.
    const wsAdmin = (
      await api(key, 'POST', `${W}/api-keys`, { name: 'adm', scopes: ['admin'] })
    ).json().key;
    expect((await api(wsAdmin, 'POST', `${W}/api-keys`, { name: 'x' })).statusCode).toBe(403);
    expect((await api(key, 'DELETE', `${W}/api-keys/${created.json().id}`)).statusCode).toBe(200);
  });

  it('deletes host apps, the default one last', async () => {
    expect((await api(key, 'DELETE', `${W}/host-apps/default`)).statusCode).toBe(409);
    expect((await api(key, 'DELETE', `${W}/host-apps/shop`)).statusCode).toBe(204);
    expect((await api(key, 'DELETE', `${W}/host-apps/default`)).statusCode).toBe(204);
    expect((await api(key, 'GET', W)).json().hostApps).toEqual([]);
  });

  it('deletes the workspace with the org key', async () => {
    expect(
      (await api(key, 'DELETE', `/api/orgs/${org}/workspaces/${ws}?delete=true`)).statusCode
    ).toBe(400);
    expect(
      (await api(key, 'DELETE', `/api/orgs/${org}/workspaces/${ws}?delete=true&confirm=${ws}`))
        .statusCode
    ).toBe(204);
    // TLC-02: deleted (restorable until purged).
    expect(
      (await app.container.systemDb.workspace.findUniqueOrThrow({ where: { slug: ws } })).deletedAt
    ).not.toBeNull();
  });
});
