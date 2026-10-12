// Copyright The Harmoniq Authors
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'crypto';
import { FastifyInstance } from 'fastify';
import { buildApp } from '../app';
import { AuthService } from '../services/authService';
import { signAccessToken } from '../auth/tokens';
import { ConsoleMailer } from '../adapters/mail/ConsoleMailer';
import { RecordingMailer } from '../services/emailLog';
import { Fixtures, bearer } from './helpers/fixtures';

// INST-19, INST-21, INST-29, INST-30: the instance's tenants and users, for its admins.
describe('Admin directory (INST-19, 21, 29, 30)', () => {
  let app: FastifyInstance;
  let fx: Fixtures;
  let root: string;
  const run = randomUUID().slice(0, 8);
  const db = () => app.container.systemDb;
  type Method = 'GET' | 'POST' | 'DELETE';
  const api = (method: Method, url: string, payload?: object, token = root) =>
    app.inject({ method, url, payload, headers: bearer(token) });
  const sent = () => ((app.container.mailer as RecordingMailer).inner as ConsoleMailer).sent;

  beforeAll(async () => {
    app = await buildApp();
    await app.ready();
    fx = new Fixtures(app);
    root = await fx.session(await fx.user({ instanceAdmin: true }));
  });

  afterAll(async () => {
    await db().organization.deleteMany({ where: { slug: { startsWith: `dir-${run}` } } });
    await db().user.deleteMany({ where: { email: { contains: run } } });
    await fx.cleanup();
    await app.close();
  });

  it('filters, sorts, pages and exports workspaces, and shows one in detail', async () => {
    const org = await db().organization.create({
      data: { slug: `dir-${run}`, name: 'Dir org', plan: 'startup' },
    });
    const made = [];
    for (const name of ['Charlie', 'Alpha', 'Bravo']) {
      const { workspace } = await fx.workspace();
      made.push(
        await db().workspace.update({
          where: { id: workspace.id },
          data: { name: `${name} ${run}`, organizationId: org.id },
        })
      );
    }
    const [charlie, alpha, bravo] = made;
    await db().workspace.update({ where: { id: bravo.id }, data: { suspendedAt: new Date() } });
    await db().workspaceConfig.upsert({
      where: { workspaceId: alpha.id },
      create: { workspaceId: alpha.id, plan: 'enterprise' },
      update: { plan: 'enterprise' },
    });

    const list = async (qs: string) =>
      (await api('GET', `/api/admin/workspaces?query=${run}&${qs}`)).json();
    expect((await list('sort=name')).workspaces.map((w: { id: string }) => w.id)).toEqual([
      alpha.id,
      bravo.id,
      charlie.id,
    ]);
    expect((await list('status=suspended')).workspaces.map((w: { id: string }) => w.id)).toEqual([
      bravo.id,
    ]);
    expect((await list('plan=enterprise')).workspaces).toHaveLength(1);
    expect((await list(`org=dir-${run}`)).total).toBe(3);
    expect((await list('org=none')).total).toBe(0);
    // None has deployed: all inactive for 0+ days; created just now, none for 30 days.
    expect((await list('inactiveDays=30')).total).toBe(0);
    const csv = await api('GET', `/api/admin/workspaces?query=${run}&format=csv`);
    expect(csv.headers['content-type']).toContain('text/csv');
    expect(csv.body.split('\n')[0]).toBe(
      'slug,name,organization,plan,members,modules,deploys,storageBytes,lastDeployAt,status,createdAt'
    );
    expect(csv.body).toContain(`${bravo.slug},Bravo ${run},dir-${run},hobby`);
    expect((await api('GET', '/api/admin/workspaces?cursor=x')).statusCode).toBe(400);

    const owner = await fx.user();
    await fx.member(alpha.id, owner.id, 'owner');
    const detail = (await api('GET', `/api/admin/workspaces/${alpha.slug}`)).json();
    expect(detail).toMatchObject({
      slug: alpha.slug,
      organization: { slug: `dir-${run}` },
      plan: { plan: 'enterprise' },
      apiKeys: { active: 0 },
      storage: null,
      sso: { scim: false },
      supportAccess: [],
    });
    expect(detail.members).toEqual([
      expect.objectContaining({ email: owner.email, role: 'owner' }),
    ]);
    expect(detail.hostApps[0].environments.map((e: { slug: string }) => e.slug)).toEqual([
      'production',
      'staging',
    ]);
    expect(detail.usage.slug).toBe(alpha.slug);
    expect((await api('GET', '/api/admin/workspaces/nope-nope')).statusCode).toBe(404);

    // INST-19: organizations, searched and in detail.
    const orgs = (await api('GET', `/api/admin/orgs?query=dir-${run}`)).json();
    expect(orgs).toMatchObject({ total: 1, organizations: [{ slug: `dir-${run}` }] });
    await db().verifiedDomain.create({
      data: { domain: `dir-${run}.test`, organizationId: org.id, token: 't', createdBy: 'test' },
    });
    const orgDetail = (await api('GET', `/api/admin/orgs/dir-${run}`)).json();
    expect(orgDetail.workspaces).toHaveLength(3);
    expect(orgDetail.domains).toEqual([expect.objectContaining({ domain: `dir-${run}.test` })]);
    expect(orgDetail.plan.plan).toBe('startup');
  });

  it('filters and exports users and shows one with sessions, which can be ended', async () => {
    const never = await db().user.create({ data: { email: `never-${run}@test.local` } });
    const active = await fx.user();
    await db().user.update({
      where: { id: active.id },
      data: { email: `active-${run}@test.local`, lastLoginAt: new Date() },
    });
    const filter = async (f: string) =>
      (await api('GET', `/api/admin/users?query=${run}&filter=${f}`))
        .json()
        .users.map((u: { id: string }) => u.id);
    expect(await filter('never')).toEqual([never.id]);
    expect(await filter('suspended')).toEqual([]);
    const csv = await api('GET', `/api/admin/users?query=${run}&format=csv`);
    expect(csv.body.split('\n')[0]).toBe(
      'email,name,createdAt,lastLoginAt,instanceAdmin,mfa,suspended,organizations,workspaces'
    );
    expect(csv.body).toContain(`never-${run}@test.local`);

    // A real session to end.
    const email = `session-${run}@test.local`;
    await new AuthService(db(), app.config.jwtSecret, app.container.logger).completeLogin(
      { providerUserId: email, email, emailVerified: true },
      'email'
    );
    const user = await db().user.findUniqueOrThrow({ where: { email } });
    const detail = (await api('GET', `/api/admin/users/${user.id}`)).json();
    expect(detail.sessions).toHaveLength(1);
    expect(detail.identities).toEqual([expect.objectContaining({ provider: 'email' })]);
    const session = detail.sessions[0].id;
    expect(
      (await api('DELETE', `/api/admin/users/${user.id}/sessions/${session}`)).statusCode
    ).toBe(204);
    expect((await api('GET', `/api/admin/users/${user.id}`)).json().sessions).toEqual([]);
    expect(
      (await api('DELETE', `/api/admin/users/${user.id}/sessions/${session}`)).statusCode
    ).toBe(404);
  });

  it('changes an email only once the new address confirms it (INST-30)', async () => {
    const user = await db().user.create({ data: { email: `old-${run}@test.local` } });
    await db().identity.create({
      data: {
        userId: user.id,
        provider: 'email',
        providerUserId: user.email,
        email: user.email,
      },
    });
    const taken = await db().user.create({ data: { email: `taken-${run}@test.local` } });
    expect(
      (await api('POST', `/api/admin/users/${user.id}/email`, { email: taken.email })).statusCode
    ).toBe(409);
    const started = await api('POST', `/api/admin/users/${user.id}/email`, {
      email: `new-${run}@test.local`,
    });
    expect(started.statusCode).toBe(202);
    // Not changed yet.
    expect((await db().user.findUniqueOrThrow({ where: { id: user.id } })).email).toBe(user.email);
    const mail = sent().find((m) => m.to === `new-${run}@test.local`)!;
    const token = new URL(mail.text.match(/https?:\/\/\S+/)![0]).searchParams.get('token')!;

    const confirm = (t: string) =>
      app.inject({ method: 'POST', url: '/api/auth/email-change', payload: { token: t } });
    expect((await confirm('x'.repeat(40))).statusCode).toBe(400);
    expect((await confirm(token)).json()).toEqual({ email: `new-${run}@test.local` });
    const after = await db().user.findUniqueOrThrow({
      where: { id: user.id },
      include: { Identities: true },
    });
    expect(after).toMatchObject({ email: `new-${run}@test.local`, pendingEmail: null });
    expect(after.Identities[0]).toMatchObject({ providerUserId: `new-${run}@test.local` });
    expect((await confirm(token)).statusCode).toBe(400);
  });

  it('merges two accounts: higher roles win, the merged account is gone (INST-30)', async () => {
    const keep = await db().user.create({ data: { email: `keep-${run}@test.local` } });
    const dup = await db().user.create({ data: { email: `dup-${run}@test.local` } });
    await db().identity.create({
      data: { userId: dup.id, provider: 'github', providerUserId: `gh-${run}`, email: dup.email },
    });
    const { workspace: shared } = await fx.workspace();
    const { workspace: only } = await fx.workspace();
    await fx.member(shared.id, keep.id, 'viewer');
    await fx.member(shared.id, dup.id, 'admin');
    await fx.member(only.id, dup.id, 'developer');

    // Instance admins aren't merged; support admins can't merge at all.
    const support = await fx.user({ instanceAdmin: true });
    await db().instanceAdmin.update({
      where: { userId: support.id },
      data: { role: 'instance_support' },
    });
    const supportToken = await signAccessToken(
      { userId: support.id, email: support.email, reauthAt: Date.now() },
      app.config.jwtSecret
    );
    expect(
      (await api('POST', `/api/admin/users/${dup.id}/merge`, { into: keep.id }, supportToken))
        .statusCode
    ).toBe(403);
    expect(
      (await api('POST', `/api/admin/users/${support.id}/merge`, { into: keep.id })).statusCode
    ).toBe(409);

    const merged = await api('POST', `/api/admin/users/${dup.id}/merge`, { into: keep.id });
    expect(merged.statusCode).toBe(200);
    expect(merged.json().moved).toMatchObject({ identities: 1, workspaces: 2 });
    expect(await db().user.findUnique({ where: { id: dup.id } })).toBeNull();
    const roles = await db().workspaceMember.findMany({
      where: { userId: keep.id },
      select: { workspaceId: true, role: true },
    });
    expect(roles).toEqual(
      expect.arrayContaining([
        { workspaceId: shared.id, role: 'admin' },
        { workspaceId: only.id, role: 'developer' },
      ])
    );
    expect(await db().identity.findFirst({ where: { providerUserId: `gh-${run}` } })).toMatchObject(
      { userId: keep.id }
    );
    expect(
      await db().instanceAuditEvent.findFirst({
        where: { action: 'instance.user_merge', resourceId: keep.id },
      })
    ).toMatchObject({ metadata: expect.objectContaining({ from: dup.email }) });
  });
});
