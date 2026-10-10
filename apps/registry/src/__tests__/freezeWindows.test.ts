// Copyright The Harmoniq Authors
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { FastifyInstance } from 'fastify';
import { buildApp } from '../app';
import { isFrozen } from '../services/manifestMutation';
import { Fixtures, bearer } from './helpers/fixtures';

describe('Freeze windows and owner overrides (M4.2)', () => {
  let app: FastifyInstance;
  let fx: Fixtures;
  let ws: string;
  let workspaceId: string;
  let owner: string;
  let admin: string;
  let key: string;

  const freezeUrl = () => `/api/workspaces/${ws}/host-apps/portal/environments/production/freeze`;
  const api = (
    as: string,
    method: 'GET' | 'POST' | 'PUT' | 'DELETE',
    url: string,
    payload?: object,
    headers: Record<string, string> = {}
  ) => app.inject({ method, url, payload, headers: { ...bearer(as), ...headers } });
  const deploy = (as: string, version: string, headers: Record<string, string> = {}) =>
    api(
      as,
      'POST',
      `/api/workspaces/${ws}/modules/checkout/deploy`,
      {
        environment: 'production',
        url: `https://cdn.example.com/checkout/${version}.js`,
        version,
        integrity: 'sha384-abc',
      },
      headers
    );
  const inHours = (h: number) => new Date(Date.now() + h * 3_600_000).toISOString();
  const override = (reason: string) => ({ 'x-harmoniq-freeze-override': reason });

  beforeAll(async () => {
    app = await buildApp();
    await app.ready();
    fx = new Fixtures(app);
    const { workspace } = await fx.workspace();
    ws = workspace.slug;
    workspaceId = workspace.id;
    const [o, a] = await Promise.all([fx.user(), fx.user()]);
    await fx.member(workspace.id, o.id, 'owner');
    await fx.member(workspace.id, a.id, 'admin');
    [owner, admin] = await Promise.all([fx.session(o), fx.session(a)]);
    key = (await fx.apiKey(workspace.id, { scopes: ['admin'] })).raw;
  });

  afterAll(async () => {
    await fx.cleanup();
    await app.close();
  });

  it('evaluates freeze windows (ENV-FRZ-04)', () => {
    const at = (h: number) => new Date(Date.now() + h * 3_600_000);
    const env = { frozenAt: new Date(), freezeFrom: at(1), freezeUntil: at(3) };
    expect(isFrozen(env)).toBe(false);
    expect(isFrozen(env, at(2))).toBe(true);
    expect(isFrozen(env, at(4))).toBe(false);
    expect(isFrozen({ ...env, freezeFrom: null }, at(2))).toBe(true);
    expect(isFrozen({ frozenAt: null, freezeFrom: null, freezeUntil: null })).toBe(false);
  });

  it('schedules a freeze that only blocks once it starts', async () => {
    const bad = await api(admin, 'PUT', freezeUrl(), {
      reason: 'release weekend',
      from: inHours(3),
      until: inHours(1),
    });
    expect(bad.statusCode).toBe(400);

    const res = await api(admin, 'PUT', freezeUrl(), {
      reason: 'release weekend',
      from: inHours(1),
      until: inHours(48),
    });
    expect(res.json()).toMatchObject({ frozen: false, freezeReason: 'release weekend' });
    expect(res.json().freezeFrom).not.toBeNull();
    const listed = (await api(admin, 'GET', `/api/workspaces/${ws}`)).json();
    const prod = listed.hostApps[0].environments.find(
      (e: { slug: string }) => e.slug === 'production'
    );
    expect(prod).toMatchObject({ frozen: false, scheduledFreeze: { reason: 'release weekend' } });
    expect((await deploy(admin, '1.0.0')).statusCode).toBe(201);

    // Move the window into the present: now it blocks.
    await app.container.systemDb.environment.updateMany({
      where: { hostApp: { workspaceId }, slug: 'production' },
      data: { freezeFrom: new Date(Date.now() - 60_000) },
    });
    expect((await deploy(admin, '1.1.0')).statusCode).toBe(423);
  });

  it('lets only owners override a freeze, with a reason, audited (ENV-FRZ-03)', async () => {
    const reason = 'Hotfix for payment outage, INC-4711';
    expect((await deploy(admin, '1.1.0', override(reason))).statusCode).toBe(403);
    expect((await deploy(key, '1.1.0', override(reason))).statusCode).toBe(403);
    expect((await deploy(owner, '1.1.0', override('because'))).statusCode).toBe(400);

    const res = await deploy(owner, '1.1.0', override(reason));
    expect(res.statusCode).toBe(201);
    const audit = await app.container.systemDb.auditEvent.findFirst({
      where: { workspaceId, action: 'env.freeze_override' },
    });
    expect(audit?.metadata).toMatchObject({
      environment: 'production',
      reason,
      freezeReason: 'release weekend',
    });
    // Without the header the freeze still holds, for the owner too.
    expect((await deploy(owner, '1.2.0')).statusCode).toBe(423);
  });

  it('opens a time-boxed override window so CI can ship a hotfix (ENV-FRZ-03)', async () => {
    const url = `${freezeUrl()}/override`;
    const body = { reason: 'Hotfix INC-4711 via CI', minutes: 30 };
    expect((await api(admin, 'POST', url, body)).statusCode).toBe(403);
    expect((await api(owner, 'POST', url, { ...body, reason: 'short' })).statusCode).toBe(400);
    expect((await deploy(key, '1.2.0')).statusCode).toBe(423);

    const opened = await api(owner, 'POST', url, body);
    expect(opened.statusCode).toBe(200);
    expect(opened.json()).toMatchObject({ frozen: true, override: { reason: body.reason } });

    // The API key itself can't override, but the window lets its deploy through.
    const res = await deploy(key, '1.2.0');
    expect(res.statusCode).toBe(201);
    const deployAudit = await app.container.systemDb.auditEvent.findFirst({
      where: { workspaceId, action: 'module.deploy', resourceId: res.json().id },
    });
    expect(deployAudit?.metadata).toMatchObject({ freezeOverride: { reason: body.reason } });
    const listed = (await api(admin, 'GET', `/api/workspaces/${ws}`)).json();
    expect(
      listed.hostApps[0].environments.find((e: { slug: string }) => e.slug === 'production')
        .freezeOverride
    ).toMatchObject({ reason: body.reason });

    expect((await api(owner, 'DELETE', url)).json().override).toBeNull();
    expect((await deploy(key, '1.3.0')).statusCode).toBe(423);
  });

  it('unfreezing clears the window', async () => {
    const res = await api(admin, 'DELETE', freezeUrl());
    expect(res.json()).toMatchObject({ frozen: false, freezeFrom: null, freezeUntil: null });
    expect((await deploy(admin, '1.2.0')).statusCode).toBe(201);
  });
});
