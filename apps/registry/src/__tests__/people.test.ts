// Copyright The Harmoniq Authors
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'crypto';
import { FastifyInstance } from 'fastify';
import { buildApp } from '../app';
import { ConsoleMailer } from '../adapters/mail/ConsoleMailer';
import { RecordingMailer } from '../services/emailLog';
import { Fixtures, bearer } from './helpers/fixtures';

// PPL-01..08 (Phase 9.3): invitations, people directory, access requests, org roles.
describe('People and invitations (PPL-01..08)', () => {
  let app: FastifyInstance;
  let fx: Fixtures;
  const run = randomUUID().slice(0, 8);
  const org = `ppl-${run}`;
  const ws = `ppl-${run}-shop`;
  const W = `/api/workspaces/${ws}`;
  let alice: string; // org admin, workspace owner
  let aliceEmail: string;
  const emails: string[] = [];

  type Method = 'GET' | 'POST' | 'PATCH' | 'DELETE';
  const api = (as: string | null, method: Method, url: string, payload?: object) =>
    app.inject({ method, url, payload, headers: as ? bearer(as) : {} });
  const db = () => app.container.systemDb;
  const sent = () => ((app.container.mailer as RecordingMailer).inner as ConsoleMailer).sent;
  const tokenFrom = (url: string) => url.split('/invite/')[1];
  /** A signed-in user with this email. */
  const person = async (email = `p-${randomUUID().slice(0, 8)}@test.local`) => {
    emails.push(email);
    const user = await db().user.create({ data: { email } });
    return { user, session: await fx.session(user) };
  };

  beforeAll(async () => {
    app = await buildApp();
    await app.ready();
    fx = new Fixtures(app);
    const a = await person();
    alice = a.session;
    aliceEmail = a.user.email;
    expect((await api(alice, 'POST', '/api/orgs', { name: org, slug: org })).statusCode).toBe(201);
    expect(
      (await api(alice, 'POST', `/api/orgs/${org}/workspaces`, { name: 'Shop', slug: ws }))
        .statusCode
    ).toBe(201);
  });

  afterAll(async () => {
    await db().workspace.deleteMany({ where: { organization: { slug: org } } });
    await db().organization.deleteMany({ where: { slug: org } });
    await db().user.deleteMany({ where: { email: { in: emails } } });
    await fx.cleanup();
    await app.close();
  });

  describe('workspace invitations (PPL-01/02)', () => {
    it('invites by email: nothing granted until accepted, the link is emailed', async () => {
      const email = `inv-${run}@test.local`;
      const res = await api(alice, 'POST', `${W}/members`, { email, role: 'developer' });
      expect(res.statusCode).toBe(201);
      const body = res.json();
      expect(body).toMatchObject({ email, role: 'developer', status: 'invited', emailed: true });
      expect(sent().at(-1)).toMatchObject({ to: email });
      expect(sent().at(-1)!.text).toContain(body.acceptUrl);
      expect(await db().workspaceMember.count({ where: { user: { email } } })).toBe(0);

      expect(
        (await api(alice, 'POST', `${W}/invitations`, { email, role: 'viewer' })).statusCode
      ).toBe(409);
      const listed = (await api(alice, 'GET', `${W}/members`)).json();
      expect(listed.invitations.map((i: { email: string }) => i.email)).toContain(email);
    });

    it('accepts with the link, only for the invited email, once', async () => {
      const email = `link-${run}@test.local`;
      const { acceptUrl } = (
        await api(alice, 'POST', `${W}/members`, { email, role: 'admin' })
      ).json();
      const token = tokenFrom(acceptUrl);
      const info = await api(null, 'GET', `/api/invitations/${token}`);
      expect(info.json()).toMatchObject({
        kind: 'workspace',
        target: { slug: ws },
        role: 'admin',
        status: 'pending',
      });

      const stranger = await person();
      const wrong = await api(stranger.session, 'POST', `/api/invitations/${token}/accept`);
      expect(wrong.statusCode).toBe(403);
      expect(wrong.json().error.message).toContain(email);

      const invitee = await person(email);
      const ok = await api(invitee.session, 'POST', `/api/invitations/${token}/accept`);
      expect(ok.statusCode).toBe(200);
      expect(ok.json()).toMatchObject({ kind: 'workspace', slug: ws, role: 'admin' });
      expect((await api(invitee.session, 'GET', W)).statusCode).toBe(200);
      expect(
        (await api(invitee.session, 'POST', `/api/invitations/${token}/accept`)).statusCode
      ).toBe(410);
    });

    it('resends with a new link and revokes; expired links are refused', async () => {
      const email = `re-${run}@test.local`;
      const first = (await api(alice, 'POST', `${W}/members`, { email, role: 'viewer' })).json();
      const resent = await api(alice, 'POST', `${W}/invitations/${first.id}/resend`);
      expect(resent.statusCode).toBe(200);
      expect(resent.json().acceptUrl).not.toBe(first.acceptUrl);
      expect(
        (await api(null, 'GET', `/api/invitations/${tokenFrom(first.acceptUrl)}`)).statusCode
      ).toBe(404);

      const invitee = await person(email);
      const token = tokenFrom(resent.json().acceptUrl);
      await db().invitation.update({
        where: { id: first.id },
        data: { expiresAt: new Date(Date.now() - 1000) },
      });
      expect(
        (await api(invitee.session, 'POST', `/api/invitations/${token}/accept`)).statusCode
      ).toBe(410);
      expect((await api(alice, 'DELETE', `${W}/invitations/${first.id}`)).statusCode).toBe(204);
      expect((await api(null, 'GET', `/api/invitations/${token}`)).json().status).toBe('revoked');
    });

    it('keeps owner invitations to owners and org admins', async () => {
      const admin = await person();
      const wsRow = await db().workspace.findUniqueOrThrow({ where: { slug: ws } });
      await fx.member(wsRow.id, admin.user.id, 'admin');
      const res = await api(admin.session, 'POST', `${W}/members`, {
        email: `own-${run}@test.local`,
        role: 'owner',
      });
      expect(res.statusCode).toBe(403);
    });
  });

  describe('organizations', () => {
    it('invites to the organization with any org role (PPL-01, PPL-08)', async () => {
      const email = `aud-${run}@test.local`;
      const res = await api(alice, 'POST', `/api/orgs/${org}/invitations`, {
        email,
        role: 'org_auditor',
      });
      expect(res.statusCode).toBe(201);
      const auditor = await person(email);
      const accepted = await api(
        auditor.session,
        'POST',
        `/api/invitations/${tokenFrom(res.json().acceptUrl)}/accept`
      );
      expect(accepted.json()).toMatchObject({ kind: 'organization', role: 'org_auditor' });

      // Auditors read the audit log, settings and people; they change nothing.
      for (const path of ['audit', 'sso', 'provisioning', 'people']) {
        expect(
          (await api(auditor.session, 'GET', `/api/orgs/${org}/${path}`)).statusCode,
          path
        ).toBe(200);
      }
      expect((await api(auditor.session, 'GET', `/api/orgs/${org}/keys`)).statusCode).toBe(403);
      expect(
        (await api(auditor.session, 'PATCH', `/api/orgs/${org}`, { name: 'x' })).statusCode
      ).toBe(403);
    });

    it('lists people with their access and how they got it (PPL-03)', async () => {
      const member = await person(`zz-member-${run}@test.local`);
      await api(alice, 'POST', `/api/orgs/${org}/members`, { email: member.user.email });
      const wsRow = await db().workspace.findUniqueOrThrow({ where: { slug: ws } });
      await fx.member(wsRow.id, member.user.id, 'developer');
      await api(alice, 'POST', `/api/orgs/${org}/invitations`, {
        email: `pending-${run}@test.local`,
        role: 'org_member',
      });

      const people = (await api(alice, 'GET', `/api/orgs/${org}/people`)).json();
      const alicePerson = people.people.find(
        (p: { user: { email: string } }) => p.user.email === aliceEmail
      );
      expect(alicePerson).toMatchObject({ orgRole: 'org_admin', implicitAdmin: true });
      expect(alicePerson.workspaces).toEqual([{ slug: ws, role: 'owner', source: 'member' }]);
      const m = people.people.find(
        (p: { user: { email: string } }) => p.user.email === member.user.email
      );
      expect(m).toMatchObject({ orgRole: 'org_member', implicitAdmin: false });
      expect(m.workspaces).toEqual([{ slug: ws, role: 'developer', source: 'member' }]);
      expect(people.invitations.map((i: { email: string }) => i.email)).toContain(
        `pending-${run}@test.local`
      );

      const filtered = (await api(alice, 'GET', `/api/orgs/${org}/people?query=zz-member`)).json();
      expect(filtered.people.map((p: { user: { email: string } }) => p.user.email)).toEqual([
        member.user.email,
      ]);
      const page = (await api(alice, 'GET', `/api/orgs/${org}/people?limit=1`)).json();
      expect(page.people).toHaveLength(1);
      expect(page.nextCursor).toBe(page.people[0].user.email);

      expect((await api(member.session, 'GET', `/api/orgs/${org}/people`)).statusCode).toBe(403);
    });

    it("shows org admins on a workspace's members page (PPL-06)", async () => {
      const admin = await person();
      await api(alice, 'POST', `/api/orgs/${org}/members`, {
        email: admin.user.email,
        role: 'org_admin',
      });
      const members = (await api(alice, 'GET', `${W}/members`)).json().members;
      const implicit = members.find(
        (m: { user: { email: string } }) => m.user.email === admin.user.email
      );
      expect(implicit).toMatchObject({ id: null, role: 'admin', source: 'org_admin' });
    });
  });

  describe('access requests (PPL-07)', () => {
    it('lets org members ask to join a workspace; admins approve or deny', async () => {
      const bob = await person();
      await api(alice, 'POST', `/api/orgs/${org}/members`, { email: bob.user.email });
      const home = (await api(bob.session, 'GET', `/api/orgs/${org}`)).json();
      expect(home.workspaces.find((w: { slug: string }) => w.slug === ws)).toMatchObject({
        yourRole: null,
        accessRequested: false,
      });

      const asked = await api(bob.session, 'POST', `${W}/access-requests`, {
        role: 'developer',
        message: 'I work on checkout',
      });
      expect(asked.statusCode).toBe(201);
      expect((await api(bob.session, 'POST', `${W}/access-requests`, {})).statusCode).toBe(409);
      expect(
        (await api(bob.session, 'GET', `/api/orgs/${org}`))
          .json()
          .workspaces.find((w: { slug: string }) => w.slug === ws).accessRequested
      ).toBe(true);

      const list = (await api(alice, 'GET', `${W}/access-requests`)).json().requests;
      expect(list[0]).toMatchObject({ role: 'developer', user: { email: bob.user.email } });
      expect((await api(bob.session, 'GET', `${W}/access-requests`)).statusCode).toBe(404);
      const approved = await api(alice, 'POST', `${W}/access-requests/${list[0].id}/approve`, {
        role: 'viewer',
      });
      expect(approved.json()).toMatchObject({ status: 'approved', role: 'viewer' });
      expect((await api(bob.session, 'GET', W)).statusCode).toBe(200);
    });

    it('refuses people outside the organization, and can deny', async () => {
      const outsider = await person();
      expect((await api(outsider.session, 'POST', `${W}/access-requests`, {})).statusCode).toBe(
        404
      );

      const carol = await person();
      await api(alice, 'POST', `/api/orgs/${org}/members`, { email: carol.user.email });
      const { id } = (await api(carol.session, 'POST', `${W}/access-requests`, {})).json();
      expect((await api(alice, 'POST', `${W}/access-requests/${id}/deny`)).json().status).toBe(
        'denied'
      );
      expect((await api(carol.session, 'GET', W)).statusCode).toBe(404);
      const wsRow = await db().workspace.findUniqueOrThrow({ where: { slug: ws } });
      expect(
        await db().auditEvent.findFirst({
          where: { workspaceId: wsRow.id, action: 'access_request.deny', resourceId: id },
        })
      ).not.toBeNull();
    });
  });
});
