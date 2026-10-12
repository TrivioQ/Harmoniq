// Copyright The Harmoniq Authors
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'crypto';
import { FastifyInstance } from 'fastify';
import { buildApp } from '../app';
import { Fixtures, bearer } from './helpers/fixtures';

// TLC-05: every workspace can get an owner, including those an org key created.
describe('Workspace owners in organizations (TLC-05)', () => {
  let app: FastifyInstance;
  let fx: Fixtures;
  let alice: string; // org admin
  let wsAdmin: string; // workspace admin, not an org admin
  let key: string; // org key with the admin scope
  const org = `own-${randomUUID().slice(0, 8)}`;
  const ws = `${org}-shop`;
  const W = `/api/workspaces/${ws}`;
  const invitee = `owner-${randomUUID()}@test.local`;
  const extraEmails: string[] = [];

  const api = (
    as: string,
    method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
    url: string,
    payload?: object
  ) => app.inject({ method, url, payload, headers: bearer(as) });
  const db = () => app.container.systemDb;
  const workspace = () => db().workspace.findUniqueOrThrow({ where: { slug: ws } });
  const share = (as: string, shared: boolean) =>
    api(as, 'PUT', `${W}/modules/checkout/shared`, { shared });

  beforeAll(async () => {
    app = await buildApp();
    await app.ready();
    fx = new Fixtures(app);
    alice = await fx.session(await fx.user());
    expect((await api(alice, 'POST', '/api/orgs', { name: 'Own', slug: org })).statusCode).toBe(
      201
    );
    key = (
      await api(alice, 'POST', `/api/orgs/${org}/keys`, { name: 'tf', scopes: ['admin'] })
    ).json().key;
  });

  afterAll(async () => {
    await db().workspace.deleteMany({ where: { organization: { slug: org } } });
    await db().organization.deleteMany({ where: { slug: org } });
    await db().user.deleteMany({ where: { email: { in: [invitee, ...extraEmails] } } });
    await fx.cleanup();
    await app.close();
  });

  it('creates a workspace with invited owners from an org key', async () => {
    const res = await api(key, 'POST', `/api/orgs/${org}/workspaces`, {
      name: 'Shop',
      slug: ws,
      owners: [invitee.toUpperCase()],
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().owners).toEqual([invitee]);
    const { id } = await workspace();
    const members = await db().workspaceMember.findMany({
      where: { workspaceId: id },
      include: { user: true },
    });
    expect(members).toHaveLength(1);
    expect(members[0]).toMatchObject({ role: 'owner', joinedAt: null });
    expect(members[0].user.email).toBe(invitee);
    expect(
      await db().auditEvent.findFirst({ where: { workspaceId: id, action: 'member.invite' } })
    ).toMatchObject({ actorType: 'apiKey', resourceId: members[0].id });

    const hostApp = await db().hostApp.findFirstOrThrow({ where: { workspaceId: id } });
    await fx.module(id, hostApp.id, 'checkout');
  });

  it('lets org admins act as owners while no owner has joined', async () => {
    // Sharing a module is owner-only (ORG-10).
    expect((await share(alice, true)).statusCode).toBe(200);
    expect((await share(alice, false)).statusCode).toBe(200);
  });

  it('lets org admins assign owners; workspace admins cannot', async () => {
    const admin = await fx.user();
    wsAdmin = await fx.session(admin);
    await fx.member((await workspace()).id, admin.id, 'admin');

    const second = `owner2-${randomUUID()}@test.local`;
    extraEmails.push(second);
    expect(
      (await api(wsAdmin, 'POST', `${W}/members`, { email: second, role: 'owner' })).statusCode
    ).toBe(403);
    const added = await api(alice, 'POST', `${W}/members`, { email: second, role: 'owner' });
    expect(added.statusCode).toBe(201);
    expect(added.json()).toMatchObject({ role: 'owner', status: 'invited' });
  });

  it('makes org admins admins again once an owner has joined', async () => {
    const { id } = await workspace();
    await db().workspaceMember.updateMany({
      where: { workspaceId: id, user: { email: invitee } },
      data: { joinedAt: new Date() },
    });
    expect((await share(alice, true)).statusCode).toBe(403);
    // Still able to manage owners (e.g. to replace one who left).
    const third = `owner3-${randomUUID()}@test.local`;
    extraEmails.push(third);
    expect(
      (await api(alice, 'POST', `${W}/members`, { email: third, role: 'owner' })).statusCode
    ).toBe(201);
  });

  it('keeps the last joined owner', async () => {
    const { id } = await workspace();
    const owner = await db().workspaceMember.findFirstOrThrow({
      where: { workspaceId: id, user: { email: invitee } },
    });
    const res = await api(alice, 'DELETE', `${W}/members/${owner.id}`);
    expect(res.statusCode).toBe(409);
  });

  it('rejects invalid owner emails', async () => {
    const res = await api(key, 'POST', `/api/orgs/${org}/workspaces`, {
      name: 'Bad',
      slug: `${org}-bad`,
      owners: ['not-an-email'],
    });
    expect(res.statusCode).toBe(400);
  });
});
