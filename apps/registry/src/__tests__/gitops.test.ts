// Copyright The Harmoniq Authors
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { FastifyInstance } from 'fastify';
import { buildApp } from '../app';
import { Fixtures, bearer } from './helpers/fixtures';

describe('GitOps: harmoniq.yaml plan / apply / import (M4.10, IaC-09..12)', () => {
  let app: FastifyInstance;
  let fx: Fixtures;
  let ws: string;
  let workspaceId: string;
  let adminKey: string;
  let deployKey: string;
  let ownerEmail: string;

  const apply = (config: object, opts: { dryRun?: boolean; prune?: boolean } = {}, as = adminKey) =>
    app.inject({
      method: 'POST',
      url: `/api/workspaces/${ws}/apply`,
      headers: bearer(as),
      payload: { config, ...opts },
    });
  const exported = async () =>
    (
      await app.inject({
        method: 'GET',
        url: `/api/workspaces/${ws}/config`,
        headers: bearer(adminKey),
      })
    ).json();
  const db = () => app.container.systemDb;

  const desired = () => ({
    version: 1,
    workspace: ws,
    hostApps: [
      {
        slug: 'shop',
        name: 'Shop',
        sharedDependencies: { react: '^18.0.0' },
        environments: [
          { slug: 'staging' },
          {
            slug: 'production',
            name: 'Production',
            default: true,
            approvalPolicy: { requiredApprovers: 2, eligibleRoles: ['admin', 'owner'] },
          },
        ],
        modules: [{ slug: 'cart', name: 'Cart', specifier: '@acme/cart', owners: [ownerEmail] }],
      },
    ],
    webhooks: [{ url: 'https://hooks.acme.test/harmoniq', events: ['deploy.success'] }],
    alertRules: [
      {
        name: 'cart-errors',
        condition: 'load_success_rate',
        threshold: 0.95,
        action: 'webhook',
        module: 'shop/cart',
        environment: 'production',
      },
    ],
  });

  beforeAll(async () => {
    app = await buildApp();
    await app.ready();
    fx = new Fixtures(app);
    const { workspace } = await fx.workspace();
    ws = workspace.slug;
    workspaceId = workspace.id;
    const owner = await fx.user();
    ownerEmail = owner.email;
    await fx.member(workspace.id, owner.id, 'owner');
    adminKey = (await fx.apiKey(workspace.id, { scopes: ['admin'] })).raw;
    deployKey = (await fx.apiKey(workspace.id, { scopes: ['deploy:write'] })).raw;
    // The fixture module serves a version, so it can't be pruned.
    const deployed = await app.inject({
      method: 'POST',
      url: `/api/workspaces/${ws}/modules/checkout/deploy`,
      headers: bearer(adminKey),
      payload: {
        environment: 'production',
        url: 'https://cdn.example.com/checkout/1.0.0.js',
        version: '1.0.0',
        integrity: 'sha384-abc',
      },
    });
    expect(deployed.statusCode).toBe(201);
  });

  afterAll(async () => {
    await fx.cleanup();
    await app.close();
  });

  it('exports the current state, which plans to no changes (IaC-12)', async () => {
    const config = await exported();
    expect(config).toMatchObject({
      version: 1,
      workspace: ws,
      hostApps: [{ slug: 'portal', modules: [{ slug: 'checkout' }] }],
    });
    const plan = await apply(config, { dryRun: true, prune: true });
    expect(plan.statusCode).toBe(200);
    expect(plan.json().changes).toEqual([]);
  });

  it('plans without changing anything, then applies (IaC-10/11)', async () => {
    const plan = (await apply(desired(), { dryRun: true })).json();
    expect(plan.summary).toEqual({ create: 8, update: 0, delete: 0, blocked: 0 });
    expect(plan.changes.map((c: { type: string; key: string }) => `${c.type} ${c.key}`)).toEqual([
      'hostApp shop',
      'environment shop/staging',
      'environment shop/production',
      'approvalPolicy shop/production',
      'module shop/cart',
      'moduleOwners shop/cart',
      'webhook https://hooks.acme.test/harmoniq',
      'alertRule cart-errors',
    ]);
    expect(await db().hostApp.count({ where: { workspaceId, slug: 'shop' } })).toBe(0);

    const applied = await apply(desired());
    expect(applied.statusCode).toBe(200);
    // The generated webhook secret is shown once.
    expect(applied.json().secrets['https://hooks.acme.test/harmoniq']).toMatch(/^whsec_/);
    const shop = await db().hostApp.findFirstOrThrow({
      where: { workspaceId, slug: 'shop' },
      include: { Environments: true, RemoteModules: { include: { ModuleOwnerships: true } } },
    });
    expect(shop.sharedDependencies).toEqual({ react: '^18.0.0' });
    const prod = shop.Environments.find((e) => e.slug === 'production')!;
    expect(prod).toMatchObject({ name: 'Production', isDefault: true });
    expect(
      await db().approvalPolicy.findFirst({ where: { environmentId: prod.id } })
    ).toMatchObject({ requiredApprovers: 2 });
    expect(shop.RemoteModules[0]).toMatchObject({ specifier: '@acme/cart' });
    expect(shop.RemoteModules[0].ModuleOwnerships).toHaveLength(1);
    expect(
      await db().alertRule.findFirst({ where: { workspaceId, name: 'cart-errors' } })
    ).toMatchObject({ remoteModuleId: shop.RemoteModules[0].id, environmentId: prod.id });
    const event = await db().auditEvent.findFirst({
      where: { workspaceId, action: 'gitops.apply' },
    });
    expect(JSON.stringify(event?.metadata)).not.toContain('whsec_');
  });

  it('is idempotent: applying again changes nothing', async () => {
    const again = (await apply(desired())).json();
    expect(again.changes).toEqual([]);
    expect(again.secrets).toBeUndefined();
  });

  it('updates what differs, leaving undeclared fields alone', async () => {
    const config = desired();
    config.hostApps[0].environments[0] = { slug: 'staging', name: 'Pre-production' } as never;
    config.hostApps[0].modules[0].specifier = '@acme/shop-cart';
    config.alertRules[0].threshold = 0.9;
    const result = (await apply(config)).json();
    expect(result.changes).toEqual([
      { action: 'update', type: 'environment', key: 'shop/staging', fields: ['name'] },
      { action: 'update', type: 'module', key: 'shop/cart', fields: ['specifier'] },
      { action: 'update', type: 'alertRule', key: 'cart-errors', fields: ['threshold'] },
    ]);
    // A webhook secret from the file replaces the stored one; then nothing changes.
    const withSecret = desired();
    withSecret.hostApps[0].modules[0].specifier = '@acme/shop-cart';
    withSecret.hostApps[0].environments[0] = { slug: 'staging', name: 'Pre-production' } as never;
    withSecret.alertRules[0].threshold = 0.9;
    (withSecret.webhooks[0] as { secret?: string }).secret = 'a-shared-secret-from-ci';
    expect((await apply(withSecret)).json().changes).toEqual([
      {
        action: 'update',
        type: 'webhook',
        key: 'https://hooks.acme.test/harmoniq',
        fields: ['secret'],
      },
    ]);
    expect((await apply(withSecret)).json().changes).toEqual([]);
  });

  it('prunes only with prune, only in declared sections, never live resources', async () => {
    const config = desired();
    config.webhooks = [];
    delete (config as { alertRules?: unknown }).alertRules;
    // Without prune: nothing is deleted.
    const plain = (await apply(config, { dryRun: true })).json();
    expect(plain.changes.filter((c: { action: string }) => c.action === 'delete')).toEqual([]);

    const pruned = (await apply(config, { dryRun: true, prune: true })).json();
    const deletes = pruned.changes.filter((c: { action: string }) => c.action === 'delete');
    expect(deletes).toEqual(
      expect.arrayContaining([
        { action: 'delete', type: 'webhook', key: 'https://hooks.acme.test/harmoniq' },
        // The fixture host app still serves checkout 1.0.0.
        {
          action: 'delete',
          type: 'hostApp',
          key: 'portal',
          blocked: 'it still serves module versions',
        },
      ])
    );
    // Alert rules aren't in the file: not managed, not pruned.
    expect(deletes.some((c: { type: string }) => c.type === 'alertRule')).toBe(false);
    expect(pruned.summary.blocked).toBe(1);

    await apply(config, { prune: true });
    expect(await db().webhookEndpoint.count({ where: { workspaceId } })).toBe(0);
    expect(await db().hostApp.count({ where: { workspaceId, slug: 'portal' } })).toBe(1);
    expect(await db().alertRule.count({ where: { workspaceId } })).toBe(1);
  });

  it('freezes and unfreezes environments declaratively', async () => {
    const config = desired();
    (config.hostApps[0].environments[1] as { freeze?: unknown }).freeze = {
      reason: 'Holiday freeze',
    };
    expect((await apply(config)).json().changes).toContainEqual({
      action: 'create',
      type: 'freeze',
      key: 'shop/production',
    });
    const env = await db().environment.findFirstOrThrow({
      where: { slug: 'production', hostApp: { workspaceId, slug: 'shop' } },
    });
    expect(env).toMatchObject({ freezeReason: 'Holiday freeze' });
    expect(env.frozenAt).not.toBeNull();

    (config.hostApps[0].environments[1] as { freeze?: unknown }).freeze = null;
    expect((await apply(config)).json().changes).toContainEqual({
      action: 'delete',
      type: 'freeze',
      key: 'shop/production',
    });
    expect(
      (await db().environment.findUniqueOrThrow({ where: { id: env.id } })).frozenAt
    ).toBeNull();
  });

  it('refuses invalid files, unknown references and other workspaces', async () => {
    const invalid = await apply({ version: 2 });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json().error.details.issues[0]).toContain('version');

    const unknown = desired();
    unknown.hostApps[0].modules[0].owners = ['stranger@nowhere.test'];
    unknown.alertRules[0].module = 'nope';
    const refused = await apply(unknown);
    expect(refused.statusCode).toBe(422);
    expect(refused.json().error.details.problems).toEqual([
      expect.stringContaining('stranger@nowhere.test is not a member'),
      expect.stringContaining('module nope not found'),
    ]);

    expect((await apply({ ...desired(), workspace: 'elsewhere' })).statusCode).toBe(400);
    // Needs admin: a deploy key may not reshape the workspace.
    expect((await apply(desired(), {}, deployKey)).statusCode).toBe(403);
  });

  it('round-trips: the export applied back is a no-op', async () => {
    const config = await exported();
    expect(config.hostApps.find((h: { slug: string }) => h.slug === 'shop')).toMatchObject({
      modules: [{ slug: 'cart', specifier: '@acme/cart', owners: [ownerEmail] }],
    });
    expect((await apply(config, { dryRun: true, prune: true })).json().changes).toEqual([]);
  });

  it('publishes the JSON Schema for editors (IaC-09)', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/schema/harmoniq.json' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      $id: 'urn:harmoniq:schema:harmoniq-yaml:v1',
      additionalProperties: false,
      properties: { version: { const: 1 } },
    });
  });
});
