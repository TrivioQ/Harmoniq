// Copyright The Harmoniq Authors
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'crypto';
import { FastifyInstance } from 'fastify';
import { buildApp } from '../app';
import { signAccessToken } from '../auth/tokens';
import { Fixtures, bearer } from './helpers/fixtures';

// INST-20: time-boxed, read-only support access, recorded in both logs and visible.
describe('Support access (INST-20)', () => {
  let app: FastifyInstance;
  let fx: Fixtures;
  const run = randomUUID().slice(0, 8);
  const db = () => app.container.systemDb;
  type Method = 'GET' | 'POST' | 'PATCH' | 'DELETE';
  const api = (as: string, method: Method, url: string, payload?: object) =>
    app.inject({ method, url, payload, headers: bearer(as) });
  const adminAs = async (role: string) => {
    const user = await fx.user({ instanceAdmin: true });
    await db().instanceAdmin.update({ where: { userId: user.id }, data: { role } });
    return {
      user,
      token: await signAccessToken(
        { userId: user.id, email: user.email, reauthAt: Date.now() },
        app.config.jwtSecret
      ),
    };
  };

  beforeAll(async () => {
    app = await buildApp();
    await app.ready();
    fx = new Fixtures(app);
  });

  afterAll(async () => {
    await db().organization.deleteMany({ where: { slug: `sup-${run}` } });
    await fx.cleanup();
    await app.close();
  });

  it('reads a workspace while the grant lasts, never changes it, and both logs know', async () => {
    const support = await adminAs('instance_support');
    const { workspace } = await fx.workspace();
    const owner = await fx.user();
    await fx.member(workspace.id, owner.id, 'owner');
    const ownerToken = await fx.session(owner);
    const audit = `/api/workspaces/${workspace.slug}/audit`;

    expect((await api(support.token, 'GET', audit)).statusCode).toBe(404);
    // A reason is required, and at most 4 hours.
    const open = (body: object) => api(support.token, 'POST', '/api/admin/support-grants', body);
    expect((await open({ workspace: workspace.slug, reason: 'short' })).statusCode).toBe(400);
    expect(
      (await open({ workspace: workspace.slug, reason: 'Ticket 123: deploys fail', hours: 5 }))
        .statusCode
    ).toBe(400);
    const granted = await open({
      workspace: workspace.slug,
      reason: 'Ticket 123: deploys fail',
      hours: 2,
    });
    expect(granted.statusCode).toBe(201);
    const grant = granted.json();

    expect((await api(support.token, 'GET', audit)).statusCode).toBe(200);
    const change = await api(support.token, 'PATCH', `/api/workspaces/${workspace.slug}`, {
      name: 'Hacked',
    });
    expect(change.statusCode).toBe(403);
    expect(change.json().error.code).toBe('SUPPORT_READ_ONLY');

    // The tenant sees it, and its log has it; so does the instance log.
    const seen = (await api(ownerToken, 'GET', `/api/workspaces/${workspace.slug}`)).json();
    expect(seen.supportAccess).toEqual([
      expect.objectContaining({ admin: support.user.email, reason: 'Ticket 123: deploys fail' }),
    ]);
    expect(
      await db().auditEvent.findFirst({
        where: { workspaceId: workspace.id, action: 'support.access_granted' },
      })
    ).toMatchObject({ actorId: support.user.id });
    expect(
      await db().instanceAuditEvent.findFirst({
        where: { action: 'instance.support_grant', resourceId: workspace.id },
      })
    ).not.toBeNull();

    // Another admin's grant gives nothing to others; a billing admin can't open one.
    const other = await adminAs('instance_operator');
    expect((await api(other.token, 'GET', audit)).statusCode).toBe(404);
    const billing = await adminAs('instance_billing');
    expect(
      (
        await api(billing.token, 'POST', '/api/admin/support-grants', {
          workspace: workspace.slug,
          reason: 'Looking around here',
        })
      ).statusCode
    ).toBe(403);

    // Revoked: gone at once, and recorded in the tenant's log.
    expect(
      (await api(support.token, 'DELETE', `/api/admin/support-grants/${grant.id}`)).statusCode
    ).toBe(204);
    expect((await api(support.token, 'GET', audit)).statusCode).toBe(404);
    expect(
      await db().auditEvent.count({
        where: { workspaceId: workspace.id, action: 'support.access_revoked' },
      })
    ).toBe(1);
  });

  it('expires on its own and covers an organization and its workspaces', async () => {
    const support = await adminAs('instance_support');
    const org = await db().organization.create({ data: { slug: `sup-${run}`, name: 'Sup' } });
    const { workspace } = await fx.workspace();
    await db().workspace.update({ where: { id: workspace.id }, data: { organizationId: org.id } });
    const orgAudit = `/api/orgs/${org.slug}/audit`;

    expect((await api(support.token, 'GET', orgAudit)).statusCode).toBe(403);
    const grant = (
      await api(support.token, 'POST', '/api/admin/support-grants', {
        organization: org.slug,
        reason: 'Customer asked for help with SSO',
      })
    ).json();
    expect((await api(support.token, 'GET', orgAudit)).statusCode).toBe(200);
    expect(
      (await api(support.token, 'GET', `/api/workspaces/${workspace.slug}/audit`)).statusCode
    ).toBe(200);
    expect(
      (await api(support.token, 'PATCH', `/api/orgs/${org.slug}`, { name: 'x' })).statusCode
    ).toBe(403);
    expect(
      await db().organizationAuditEvent.count({
        where: { organizationId: org.id, action: 'support.access_granted' },
      })
    ).toBe(1);

    // Past its end it no longer opens anything.
    await db().supportGrant.update({
      where: { id: grant.id },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    expect((await api(support.token, 'GET', orgAudit)).statusCode).toBe(403);
    const list = (await api(support.token, 'GET', '/api/admin/support-grants')).json().grants;
    expect(list.find((g: { id: string }) => g.id === grant.id)).toMatchObject({
      active: false,
      organization: org.slug,
    });
  });
});
