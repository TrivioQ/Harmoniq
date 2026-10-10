// Copyright The Harmoniq Authors
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'crypto';
import { FastifyInstance } from 'fastify';
import { buildApp } from '../app';
import { Fixtures, bearer } from './helpers/fixtures';

describe('Organizations (M4.7, ORG-01..15)', () => {
  let app: FastifyInstance;
  let fx: Fixtures;
  let alice: string; // creates the org
  let bob: string; // org member, later org admin
  let carol: string; // not in the org
  let bobEmail: string;
  let design: string; // standalone workspace of alice, attached later (shares modules)
  let shop: string; // created inside the org
  let shopId: string;
  let outside: string; // carol's workspace, never in the org
  const org = `org-${randomUUID().slice(0, 8)}`;

  const api = (
    as: string | null,
    method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
    url: string,
    payload?: object
  ) => app.inject({ method, url, payload, headers: as ? bearer(as) : {} });
  const deploy = (as: string, ws: string, module: string, version: string) =>
    api(as, 'POST', `/api/workspaces/${ws}/modules/${module}/deploy`, {
      environment: 'production',
      url: `https://cdn.example.com/${module}/${version}.js`,
      version,
      integrity: 'sha384-abc',
    });
  const manifest = async (ws: string, host: string) =>
    (await api(null, 'GET', `/api/manifest/${ws}/${host}/production`)).json();

  beforeAll(async () => {
    app = await buildApp();
    await app.ready();
    fx = new Fixtures(app);
    const [a, b, c] = await Promise.all([fx.user(), fx.user(), fx.user()]);
    bobEmail = b.email;
    [alice, bob, carol] = await Promise.all([a, b, c].map((u) => fx.session(u)));
    const d = await fx.workspace();
    design = d.workspace.slug;
    await fx.member(d.workspace.id, a.id, 'owner');
    const o = await fx.workspace();
    outside = o.workspace.slug;
    await fx.member(o.workspace.id, c.id, 'owner');
  });

  afterAll(async () => {
    const db = app.container.systemDb;
    await db.workspace.deleteMany({ where: { organization: { slug: org } } });
    await db.organization.deleteMany({ where: { slug: org } });
    await fx.cleanup();
    await app.close();
  });

  it('creates an organization and its workspaces (ORG-01/03/08)', async () => {
    expect((await api(alice, 'POST', '/api/orgs', { name: 'Acme', slug: org })).statusCode).toBe(
      201
    );
    expect((await api(carol, 'POST', '/api/orgs', { name: 'Acme', slug: org })).statusCode).toBe(
      409
    );

    shop = `shop-${randomUUID().slice(0, 8)}`;
    const created = await api(alice, 'POST', `/api/orgs/${org}/workspaces`, {
      name: 'Shop',
      slug: shop,
    });
    expect(created.statusCode).toBe(201);
    shopId = (await app.container.systemDb.workspace.findUniqueOrThrow({ where: { slug: shop } }))
      .id;
    expect(
      (await api(alice, 'POST', `/api/orgs/${org}/workspaces/${design}/attach`)).statusCode
    ).toBe(200);
    // Only owners attach their own workspaces.
    expect(
      (await api(alice, 'POST', `/api/orgs/${org}/workspaces/${outside}/attach`)).statusCode
    ).toBe(404);

    const me = (await api(alice, 'GET', '/api/me')).json();
    expect(me.organizations).toEqual([{ slug: org, name: 'Acme', role: 'org_admin' }]);
    expect(me.workspaces.find((w: { slug: string }) => w.slug === shop)).toMatchObject({
      organization: org,
      role: 'owner',
    });
    const home = (await api(alice, 'GET', `/api/orgs/${org}`)).json();
    expect(home.workspaces.map((w: { slug: string }) => w.slug).sort()).toEqual(
      [design, shop].sort()
    );
    expect((await api(carol, 'GET', `/api/orgs/${org}`)).statusCode).toBe(404);
  });

  it('org admins administer every workspace; org members only see the org (ORG-04/08)', async () => {
    const added = await api(alice, 'POST', `/api/orgs/${org}/members`, { email: bobEmail });
    expect(added.statusCode).toBe(201);
    expect((await api(bob, 'GET', `/api/orgs/${org}`)).statusCode).toBe(200);
    expect((await api(bob, 'GET', `/api/orgs/${org}/audit`)).statusCode).toBe(403);
    expect((await api(bob, 'GET', `/api/workspaces/${shop}/modules`)).statusCode).toBe(404);

    await api(alice, 'PATCH', `/api/orgs/${org}/members/${added.json().id}`, { role: 'org_admin' });
    expect((await api(bob, 'GET', `/api/workspaces/${shop}/modules`)).statusCode).toBe(200);
    // Admin, not owner: owner-only actions stay with owners.
    const owners = await api(bob, 'PUT', `/api/workspaces/${design}/modules/checkout/shared`, {
      shared: true,
    });
    expect(owners.statusCode).toBe(403);
    expect((await api(bob, 'GET', `/api/workspaces/${outside}/modules`)).statusCode).toBe(404);

    const members = (await api(alice, 'GET', `/api/orgs/${org}/members`)).json().members;
    const aliceMember = members.find(
      (m: { role: string; user: { email: string } }) => m.user.email !== bobEmail
    );
    await api(alice, 'PATCH', `/api/orgs/${org}/members/${added.json().id}`, {
      role: 'org_member',
    });
    expect(
      (await api(alice, 'DELETE', `/api/orgs/${org}/members/${aliceMember.id}`)).statusCode
    ).toBe(409);
    await api(alice, 'PATCH', `/api/orgs/${org}/members/${added.json().id}`, { role: 'org_admin' });
  });

  it('shares modules into the other workspaces’ manifests (ORG-10/11/12)', async () => {
    expect((await deploy(alice, design, 'checkout', '1.0.0')).statusCode).toBe(201);
    expect(
      (
        await api(alice, 'PUT', `/api/workspaces/${design}/modules/checkout/shared`, {
          shared: true,
        })
      ).json()
    ).toMatchObject({ shared: true });

    const seen = await manifest(shop, 'default');
    expect(seen.modules).toContainEqual(
      expect.objectContaining({
        name: 'checkout',
        version: '1.0.0',
        shared: true,
        ownerWorkspace: design,
      })
    );
    // A new version reaches the other workspace (its cached manifest is refreshed).
    await deploy(alice, design, 'checkout', '1.1.0');
    expect(
      (await manifest(shop, 'default')).modules.find((m: { name: string }) => m.name === 'checkout')
    ).toMatchObject({ version: '1.1.0', shared: true });
    // Not in the owner's own manifest twice, and never outside the org.
    const own = (await manifest(design, 'portal')).modules.filter(
      (m: { name: string }) => m.name === 'checkout'
    );
    expect(own).toHaveLength(1);
    expect(own[0].shared).toBeUndefined();
    expect(
      (await manifest(outside, 'portal')).modules.some((m: { shared?: boolean }) => m.shared)
    ).toBe(false);

    const catalog = (await api(bob, 'GET', `/api/orgs/${org}/modules`)).json().modules;
    expect(
      catalog.find(
        (m: { workspace: string; slug: string }) => m.workspace === design && m.slug === 'checkout'
      )
    ).toMatchObject({ shared: true, versions: { production: '1.1.0' } });

    await api(alice, 'PUT', `/api/workspaces/${design}/modules/checkout/shared`, { shared: false });
    expect(
      (await manifest(shop, 'default')).modules.some((m: { name: string }) => m.name === 'checkout')
    ).toBe(false);
  });

  it('org API keys reach the org’s (listed) workspaces only (ORG-13)', async () => {
    const scoped = await api(alice, 'POST', `/api/orgs/${org}/keys`, {
      name: 'ci',
      scopes: ['deploy:write'],
      workspaces: [design],
    });
    expect(scoped.statusCode).toBe(201);
    const key = scoped.json().key as string;
    expect(key).toMatch(/^hq_org_/);
    expect((await api(key, 'GET', `/api/workspaces/${design}/modules`)).statusCode).toBe(200);
    expect((await deploy(key, design, 'checkout', '1.2.0')).statusCode).toBe(201);
    expect((await api(key, 'GET', `/api/workspaces/${shop}/modules`)).statusCode).toBe(403);
    expect((await api(key, 'GET', `/api/workspaces/${outside}/modules`)).statusCode).toBe(403);
    expect(
      (await api(alice, 'POST', `/api/orgs/${org}/keys`, { name: 'x', workspaces: [outside] }))
        .statusCode
    ).toBe(400);

    const all = (
      await api(alice, 'POST', `/api/orgs/${org}/keys`, { name: 'all', scopes: ['manifest:read'] })
    ).json().key;
    expect((await api(all, 'GET', `/api/workspaces/${shop}/modules`)).statusCode).toBe(200);
    expect((await deploy(all, shop, 'checkout', '1.0.0')).statusCode).toBe(403);

    expect(
      (await api(alice, 'DELETE', `/api/orgs/${org}/keys/${scoped.json().id}`)).statusCode
    ).toBe(204);
    expect((await api(key, 'GET', `/api/workspaces/${design}/modules`)).statusCode).toBe(401);
  });

  it('shows one audit log across the org, filterable and paginated (ORG-09)', async () => {
    const all = (await api(alice, 'GET', `/api/orgs/${org}/audit?limit=200`)).json().events;
    const actions = all.map((e: { action: string }) => e.action);
    expect(actions).toEqual(
      expect.arrayContaining(['org.create', 'org.member_add', 'module.deploy', 'workspace.create'])
    );
    expect(new Set(all.map((e: { workspace: string | null }) => e.workspace))).toEqual(
      new Set([null, design, shop])
    );

    const onlyShop = (await api(alice, 'GET', `/api/orgs/${org}/audit?workspace=${shop}`)).json()
      .events;
    expect(onlyShop.every((e: { workspace: string }) => e.workspace === shop)).toBe(true);

    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const page: { events: { id: string }[]; nextCursor: string | null } = (
        await api(
          alice,
          'GET',
          `/api/orgs/${org}/audit?limit=3${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`
        )
      ).json();
      seen.push(...page.events.map((e: { id: string }) => e.id));
      cursor = page.nextCursor;
    } while (cursor);
    expect(seen).toEqual(all.map((e: { id: string }) => e.id));
  });

  it('detaches and deletes workspaces; access through the org ends', async () => {
    expect((await api(alice, 'DELETE', `/api/orgs/${org}/workspaces/${design}`)).statusCode).toBe(
      204
    );
    expect((await api(bob, 'GET', `/api/workspaces/${design}/modules`)).statusCode).toBe(404);
    expect((await api(alice, 'GET', `/api/workspaces/${design}/modules`)).statusCode).toBe(200);

    expect((await api(alice, 'DELETE', `/api/orgs/${org}`)).statusCode).toBe(409); // not empty
    expect(
      (await api(alice, 'DELETE', `/api/orgs/${org}/workspaces/${shop}?delete=true&confirm=nope`))
        .statusCode
    ).toBe(400);
    expect(
      (await api(bob, 'DELETE', `/api/orgs/${org}/workspaces/${shop}?delete=true&confirm=${shop}`))
        .statusCode
    ).toBe(204);
    expect(await app.container.systemDb.workspace.findUnique({ where: { id: shopId } })).toBeNull();
    expect((await api(alice, 'DELETE', `/api/orgs/${org}`)).statusCode).toBe(204);
    expect((await api(alice, 'GET', `/api/orgs/${org}`)).statusCode).toBe(404);
  });
});
