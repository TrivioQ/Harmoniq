// Copyright The Harmoniq Authors
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { FastifyInstance } from 'fastify';
import { ManifestSchema } from '@harmoniq/core/dist/schemas/ManifestSchema';
import { buildApp } from '../app';
import { Fixtures, bearer } from './helpers/fixtures';

describe('Kill switch (M3.6)', () => {
  let app: FastifyInstance;
  let fx: Fixtures;
  let ws: string;
  let workspaceId: string;
  let token: string;

  const api = (method: 'GET' | 'POST' | 'PUT', url: string, payload?: object, as = token) =>
    app.inject({ method, url, payload, headers: bearer(as) });
  const kill = (body: object, as = token) =>
    api('PUT', `/api/workspaces/${ws}/modules/checkout/kill-switch`, body, as);
  const get = (path: string) => app.inject({ method: 'GET', url: path });

  beforeAll(async () => {
    app = await buildApp();
    await app.ready();
    fx = new Fixtures(app);
    const { workspace } = await fx.workspace();
    ws = workspace.slug;
    workspaceId = workspace.id;
    const owner = await fx.user();
    await fx.member(workspace.id, owner.id, 'owner');
    token = await fx.session(owner);
    const deployed = await api('POST', `/api/workspaces/${ws}/modules/checkout/deploy`, {
      environment: 'production',
      url: 'https://cdn.example.com/checkout/1.0.0.js',
      version: '1.0.0',
      integrity: 'sha384-abc',
    });
    expect(deployed.statusCode).toBe(201);
  });

  afterAll(async () => {
    await fx.cleanup();
    await app.close();
  });

  it('needs a reason, and at least the developer role', async () => {
    expect((await kill({ environment: 'production', disabled: true })).statusCode).toBe(400);
    const viewer = await fx.user();
    await fx.member(workspaceId, viewer.id, 'viewer');
    const res = await kill(
      { environment: 'production', disabled: true, reason: 'broken checkout' },
      await fx.session(viewer)
    );
    expect(res.statusCode).toBe(403);
  });

  it('marks the module disabled in every format, even in a frozen environment', async () => {
    await api('PUT', `/api/workspaces/${ws}/host-apps/portal/environments/production/freeze`, {
      reason: 'release day',
    });
    const dispatch = vi.spyOn(app.container.webhooks, 'dispatch');
    const res = await kill({
      environment: 'production',
      disabled: true,
      reason: 'broken checkout',
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ disabled: true, reason: 'broken checkout' });

    const manifest = ManifestSchema.parse(
      (await get(`/api/manifest/${ws}/portal/production`)).json()
    );
    expect(manifest.modules[0]).toMatchObject({
      name: 'checkout',
      disabled: true,
      disabledReason: 'broken checkout',
    });
    expect((await get(`/api/importmap/${ws}/portal/production`)).json().imports).toEqual({});
    expect((await get(`/api/federation-manifest/${ws}/portal/production`)).json()).toEqual({});

    const listed = (await api('GET', `/api/workspaces/${ws}/modules`))
      .json()
      .modules[0].environments.find((e: { slug: string }) => e.slug === 'production');
    expect(listed.disabled).toMatchObject({ reason: 'broken checkout' });

    const audit = await app.container.systemDb.auditEvent.findFirst({
      where: { workspaceId, action: 'module.disable' },
    });
    expect(audit?.metadata).toMatchObject({ environment: 'production', reason: 'broken checkout' });
    expect(dispatch.mock.calls.some((c) => c[1] === 'module.disabled')).toBe(true);
    dispatch.mockRestore();
  });

  it('re-enables the module', async () => {
    const res = await kill({ environment: 'production', disabled: false });
    expect(res.json()).toMatchObject({ disabled: false, reason: null });
    const manifest = (await get(`/api/manifest/${ws}/portal/production`)).json();
    expect(manifest.modules[0].disabled).toBeUndefined();
    expect((await get(`/api/importmap/${ws}/portal/production`)).json().imports).toHaveProperty(
      'checkout'
    );
  });
});
