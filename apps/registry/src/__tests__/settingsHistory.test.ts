// Copyright The Harmoniq Authors
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { FastifyInstance } from 'fastify';
import { buildApp } from '../app';
import { Fixtures, bearer } from './helpers/fixtures';

// INST-34 (settings once only in the environment) and INST-35 (versions, export, import).
describe('Instance settings: new keys, history, export and import (INST-34/35)', () => {
  let app: FastifyInstance;
  let replica: FastifyInstance;
  let fx: Fixtures;
  let root: string;

  type Method = 'GET' | 'POST' | 'PUT' | 'DELETE';
  const api = (method: Method, url: string, payload?: object) =>
    app.inject({ method, url, payload, headers: bearer(root) });
  const db = () => app.container.systemDb;
  const KEYS = ['plans', 'rateLimits', 'gc', 'bundles', 'branding', 'email'];

  beforeAll(async () => {
    app = await buildApp();
    replica = await buildApp();
    await Promise.all([app.ready(), replica.ready()]);
    fx = new Fixtures(app);
    root = await fx.session(await fx.user({ instanceAdmin: true }));
    for (const key of KEYS) await api('DELETE', `/api/admin/settings/${key}`);
    await db().instanceConfigVersion.deleteMany({ where: { key: { in: KEYS } } });
  });

  afterAll(async () => {
    for (const key of KEYS) await api('DELETE', `/api/admin/settings/${key}`);
    await db().instanceConfigVersion.deleteMany({ where: { key: { in: KEYS } } });
    await fx.cleanup();
    await Promise.all([app.close(), replica.close()]);
  });

  it('applies plans, limits, GC and bundle settings without a restart, on every replica', async () => {
    const { settings } = app.container;
    expect(settings.gc().keepVersions).toBe(app.config.gcKeepVersions);
    expect(
      (await api('PUT', '/api/admin/settings/gc', { keepVersions: 3, defaultRetentionDays: 45 }))
        .statusCode
    ).toBe(200);
    expect(settings.gc()).toMatchObject({ keepVersions: 3, defaultRetentionDays: 45 });
    expect((await api('PUT', '/api/admin/settings/bundles', { validate: true })).statusCode).toBe(
      200
    );
    expect(settings.bundles().validate).toBe(true);

    // Plans: enforcement and a quota, effective at once.
    await api('PUT', '/api/admin/settings/plans', {
      enforced: true,
      limits: { hobby: { modules: 1 } },
    });
    const plans = settings.plans();
    expect(plans.enforced).toBe(true);
    expect(plans.limits.hobby.modules).toBe(1);
    // Other quotas keep the environment's values.
    expect(plans.limits.hobby.members).toBe(app.config.plans.limits.hobby.members);
    const { workspace } = await fx.workspace();
    const owner = await fx.user();
    await fx.member(workspace.id, owner.id, 'owner');
    const created = await app.inject({
      method: 'POST',
      url: `/api/workspaces/${workspace.slug}/modules`,
      headers: bearer(await fx.session(owner)),
      payload: { hostApp: 'portal', name: 'Extra', slug: 'extra' },
    });
    expect(created.statusCode).toBe(402);

    // A new workspace gets the default retention.
    const ws = await app.inject({
      method: 'POST',
      url: '/api/workspaces',
      headers: bearer(await fx.session(owner)),
      payload: { name: 'Ret', slug: `ret-${workspace.slug.slice(3)}` },
    });
    expect(ws.statusCode).toBe(201);
    expect(
      (
        await db().workspace.findUniqueOrThrow({
          where: { slug: `ret-${workspace.slug.slice(3)}` },
        })
      ).retentionDays
    ).toBe(45);
    await db().workspace.deleteMany({ where: { slug: `ret-${workspace.slug.slice(3)}` } });

    // The other replica has it after its reload (every 60 s; forced here).
    await replica.container.settings.reload();
    expect(replica.container.settings.gc().keepVersions).toBe(3);
    expect(replica.container.settings.plans().limits.hobby.modules).toBe(1);
    await api('DELETE', '/api/admin/settings/plans');
  });

  it('keeps every version, shows what changed, and restores one', async () => {
    await api('PUT', '/api/admin/settings/branding', { name: 'First' });
    await api('PUT', '/api/admin/settings/branding', {
      name: 'Second',
      supportUrl: 'https://help.example.com',
    });
    const history = (await api('GET', '/api/admin/settings/branding/history')).json().versions;
    expect(history.map((v: { version: number }) => v.version)).toEqual([2, 1]);
    expect(history[0]).toMatchObject({ source: 'save', changed: ['name', 'supportUrl'] });

    const restored = await api('POST', '/api/admin/settings/branding/history/1/restore');
    expect(restored.statusCode).toBe(200);
    expect(app.container.settings.branding()).toMatchObject({ name: 'First' });
    expect(
      (await api('GET', '/api/admin/settings/branding/history')).json().versions[0]
    ).toMatchObject({ version: 3, source: 'restore' });

    await api('DELETE', '/api/admin/settings/branding');
    const versions = (await api('GET', '/api/admin/settings/branding/history')).json().versions;
    expect(versions[0]).toMatchObject({ version: 4, source: 'reset' });
    expect((await api('POST', '/api/admin/settings/branding/history/9/restore')).statusCode).toBe(
      404
    );
  });

  it('never shows secrets in history or exports', async () => {
    await api('PUT', '/api/admin/settings/email', {
      host: 'smtp.example.com',
      port: 587,
      security: 'starttls',
      username: 'mailer',
      password: 'super-secret-pw',
      from: 'noreply@example.com',
    });
    const history = await api('GET', '/api/admin/settings/email/history');
    expect(history.body).not.toContain('super-secret-pw');
    expect(history.json().versions[0].secretsChanged).toBe(true);
    const exported = await api('GET', '/api/admin/settings/export');
    expect(exported.headers['content-type']).toContain('yaml');
    expect(exported.body).toContain('smtp.example.com');
    expect(exported.body).not.toContain('super-secret-pw');
    await api('DELETE', '/api/admin/settings/email');
  });

  it('imports an export: a dry run shows the changes; applying saves them', async () => {
    await api('PUT', '/api/admin/settings/branding', { name: 'Before' });
    const yaml = (await api('GET', '/api/admin/settings/export')).body.replace('Before', 'After');
    const dry = await api('PUT', '/api/admin/settings/import', { yaml });
    expect(dry.json()).toMatchObject({
      dryRun: true,
      settings: expect.arrayContaining([{ key: 'branding', changed: ['name'] }]),
    });
    expect(app.container.settings.branding().name).toBe('Before');

    const applied = await api('PUT', '/api/admin/settings/import', { yaml, dryRun: false });
    expect(applied.statusCode).toBe(200);
    expect(app.container.settings.branding().name).toBe('After');
    expect(
      (await api('GET', '/api/admin/settings/branding/history')).json().versions[0].source
    ).toBe('import');

    expect((await api('PUT', '/api/admin/settings/import', { yaml: ': : :' })).statusCode).toBe(
      400
    );
    expect(
      (
        await api('PUT', '/api/admin/settings/import', {
          yaml: 'harmoniq: instance-settings/v1\nsettings:\n  nope: {}\n',
        })
      ).statusCode
    ).toBe(400);
  });
});
