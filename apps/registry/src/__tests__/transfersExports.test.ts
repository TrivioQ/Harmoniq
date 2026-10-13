// Copyright The Harmoniq Authors
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'crypto';
import { FastifyInstance } from 'fastify';
import { buildApp } from '../app';
import { Fixtures, bearer } from './helpers/fixtures';

// TLC-06 (ownership transfers) and TLC-07 (tenant exports).
describe('Ownership transfers and exports (TLC-06, TLC-07)', () => {
  let app: FastifyInstance;
  let fx: Fixtures;
  const run = randomUUID().slice(0, 8);
  const org = `xfer-${run}`;

  type Method = 'GET' | 'POST' | 'DELETE';
  const api = (as: string, method: Method, url: string, payload?: object) =>
    app.inject({ method, url, payload, headers: bearer(as) });
  const db = () => app.container.systemDb;

  /** A workspace with an owner, an admin and a developer. */
  async function team() {
    const { workspace, hostApp } = await fx.workspace();
    const [o, a, d] = await Promise.all([fx.user(), fx.user(), fx.user()]);
    await Promise.all([
      fx.member(workspace.id, o.id, 'owner'),
      fx.member(workspace.id, a.id, 'admin'),
      fx.member(workspace.id, d.id, 'developer'),
    ]);
    const [owner, admin, dev] = await Promise.all([o, a, d].map((u) => fx.session(u)));
    return { workspace, hostApp, owner, admin, dev, users: { o, a, d } };
  }
  const roleOf = async (workspaceId: string, userId: string) =>
    (await db().workspaceMember.findFirstOrThrow({ where: { workspaceId, userId } })).role;

  beforeAll(async () => {
    app = await buildApp();
    await app.ready();
    fx = new Fixtures(app);
  });

  afterAll(async () => {
    await db().workspace.deleteMany({ where: { organization: { slug: org } } });
    await db().organization.deleteMany({ where: { slug: org } });
    await fx.cleanup();
    await app.close();
  });

  describe('workspace transfers', () => {
    it('hands the workspace to a member who accepts; the sender becomes an admin', async () => {
      const { workspace, owner, admin, dev, users } = await team();
      const W = `/api/workspaces/${workspace.slug}/transfer`;
      expect((await api(admin, 'POST', W, { email: users.d.email })).statusCode).toBe(403);
      expect((await api(owner, 'POST', W, { email: 'nobody@test.local' })).statusCode).toBe(400);

      const proposed = await api(owner, 'POST', W, { email: users.a.email });
      expect(proposed.statusCode).toBe(201);
      const { id } = proposed.json();
      expect((await api(admin, 'GET', '/api/transfers')).json().incoming[0]).toMatchObject({
        id,
        workspace: { slug: workspace.slug },
        from: users.o.email,
      });
      expect((await api(owner, 'GET', '/api/transfers')).json().outgoing[0].id).toBe(id);

      // Only the recipient accepts.
      expect((await api(dev, 'POST', `/api/transfers/${id}/accept`)).statusCode).toBe(404);
      const accepted = await api(admin, 'POST', `/api/transfers/${id}/accept`);
      expect(accepted.statusCode).toBe(200);
      expect(await roleOf(workspace.id, users.a.id)).toBe('owner');
      expect(await roleOf(workspace.id, users.o.id)).toBe('admin');
      expect((await api(admin, 'POST', `/api/transfers/${id}/accept`)).statusCode).toBe(404);
      expect(
        await db().auditEvent.findFirst({
          where: { workspaceId: workspace.id, action: 'workspace.transfer_accept' },
        })
      ).toMatchObject({ actorId: users.a.id });
    });

    it('expires, can be withdrawn or declined, and replaces an earlier proposal', async () => {
      const { workspace, owner, admin, dev, users } = await team();
      const W = `/api/workspaces/${workspace.slug}/transfer`;
      const first = (await api(owner, 'POST', W, { email: users.a.email })).json().id;
      const second = (await api(owner, 'POST', W, { email: users.d.email })).json().id;
      expect((await api(admin, 'POST', `/api/transfers/${first}/accept`)).statusCode).toBe(404);

      await db().ownershipTransfer.update({
        where: { id: second },
        data: { expiresAt: new Date(Date.now() - 1000) },
      });
      expect((await api(dev, 'POST', `/api/transfers/${second}/accept`)).statusCode).toBe(410);

      const third = (await api(owner, 'POST', W, { email: users.d.email })).json().id;
      expect((await api(dev, 'POST', `/api/transfers/${third}/cancel`)).statusCode).toBe(204);
      expect((await api(dev, 'POST', `/api/transfers/${third}/accept`)).statusCode).toBe(404);
      expect(await roleOf(workspace.id, users.o.id)).toBe('owner');
      expect(
        await db().auditEvent.findFirst({
          where: { workspaceId: workspace.id, action: 'transfer.decline' },
        })
      ).not.toBeNull();
    });
  });

  it("hands an organization's admin seat to a member (TLC-06)", async () => {
    const [a, b] = await Promise.all([fx.user(), fx.user()]);
    const [alice, bob] = await Promise.all([fx.session(a), fx.session(b)]);
    await api(alice, 'POST', '/api/orgs', { name: org, slug: org });
    await api(alice, 'POST', `/api/orgs/${org}/members`, { email: b.email });
    const proposed = await api(alice, 'POST', `/api/orgs/${org}/transfer`, { email: b.email });
    expect(proposed.statusCode).toBe(201);
    expect(
      (await api(bob, 'POST', `/api/transfers/${proposed.json().id}/accept`)).json()
    ).toMatchObject({ organization: org, role: 'org_admin' });
    const roles = await db().organizationMember.findMany({
      where: { organization: { slug: org } },
      select: { userId: true, role: true },
    });
    expect(roles.find((r) => r.userId === b.id)?.role).toBe('org_admin');
    expect(roles.find((r) => r.userId === a.id)?.role).toBe('org_member');
  });

  describe('exports (TLC-07)', () => {
    const lines = (body: string) =>
      body
        .trim()
        .split('\n')
        .map((l) => JSON.parse(l) as { type: string; [k: string]: unknown });

    it("exports a workspace's config, members, modules, versions and audit log", async () => {
      const { workspace, hostApp, owner, dev } = await team();
      const module = await fx.module(workspace.id, hostApp.id, 'cart');
      const env = await db().environment.findFirstOrThrow({ where: { hostAppId: hostApp.id } });
      await db().moduleVersion.create({
        data: {
          workspaceId: workspace.id,
          remoteModuleId: module.id,
          environmentId: env.id,
          version: '3.1.4',
          url: 'https://cdn.example.test/cart.js',
          integrity: 'sha384-x',
          status: 'active',
          deployedBy: 'test',
          deployedByType: 'user',
        },
      });
      const url = `/api/workspaces/${workspace.slug}/export`;
      expect((await api(dev, 'GET', url)).statusCode).toBe(403);
      const res = await api(owner, 'GET', url);
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-disposition']).toContain('.jsonl');
      const records = lines(res.body);
      expect(records[0]).toMatchObject({ type: 'export', format: 'harmoniq.export.v1' });
      const types = new Set(records.map((r) => r.type));
      for (const t of ['workspace', 'config', 'member', 'module', 'version', 'audit']) {
        expect(types, t).toContain(t);
      }
      expect(records.find((r) => r.type === 'version')).toMatchObject({
        module: 'cart',
        version: '3.1.4',
      });
      expect(records.filter((r) => r.type === 'member')).toHaveLength(3);
      // The export itself is audited (and part of the log it exports).
      expect(records.some((r) => r.type === 'audit' && r.action === 'workspace.export')).toBe(true);
    });

    it('exports an organization with its live workspaces, without key secrets', async () => {
      const admin = await fx.user();
      const as = await fx.session(admin);
      const slug = `${org}-exp`;
      await api(as, 'POST', '/api/orgs', { name: slug, slug });
      await api(as, 'POST', `/api/orgs/${slug}/workspaces`, { name: 'Live', slug: `${slug}-live` });
      await api(as, 'POST', `/api/orgs/${slug}/workspaces`, { name: 'Gone', slug: `${slug}-gone` });
      await api(
        as,
        'DELETE',
        `/api/orgs/${slug}/workspaces/${slug}-gone?delete=true&confirm=${slug}-gone`
      );
      await api(as, 'POST', `/api/orgs/${slug}/keys`, { name: 'ci', scopes: ['deploy:write'] });

      const res = await api(as, 'GET', `/api/orgs/${slug}/export`);
      expect(res.statusCode).toBe(200);
      const records = lines(res.body);
      expect(records.find((r) => r.type === 'organization')).toMatchObject({ slug });
      expect(records.find((r) => r.type === 'org_key')).toMatchObject({ name: 'ci' });
      expect(res.body).not.toContain('keyHash');
      expect(records.some((r) => r.type === 'org_audit' && r.action === 'org.export')).toBe(true);
      const workspaces = records.filter((r) => r.type === 'workspace').map((r) => r.slug);
      expect(workspaces).toEqual([`${slug}-live`]);

      await db().workspace.deleteMany({ where: { organization: { slug } } });
      await db().organization.deleteMany({ where: { slug } });
    });
  });
});
