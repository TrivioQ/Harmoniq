// Copyright The Harmoniq Authors
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'crypto';
import { FastifyInstance } from 'fastify';
import { buildApp } from '../app';
import { Fixtures, bearer } from './helpers/fixtures';

// PPL-04/05: removing someone removes their access, not just one membership row.
describe('Offboarding (PPL-04, PPL-05)', () => {
  let app: FastifyInstance;
  let fx: Fixtures;
  let alice: string; // org admin, owner of the workspaces she creates
  const org = `off-${randomUUID().slice(0, 8)}`;
  const ws1 = `${org}-one`;
  const ws2 = `${org}-two`;
  const ws3 = `${org}-three`;

  const api = (as: string, method: 'GET' | 'POST' | 'DELETE', url: string, payload?: object) =>
    app.inject({ method, url, payload, headers: bearer(as) });
  const db = () => app.container.systemDb;
  const wsId = async (slug: string) =>
    (await db().workspace.findUniqueOrThrow({ where: { slug } })).id;

  /** A user in the org (org_member), returned with their org membership id. */
  async function orgUser() {
    const user = await fx.user();
    expect(
      (await api(alice, 'POST', `/api/orgs/${org}/members`, { email: user.email })).statusCode
    ).toBe(201);
    const member = await db().organizationMember.findFirstOrThrow({
      where: { organization: { slug: org }, userId: user.id },
    });
    return { user, memberId: member.id };
  }

  async function keyBy(userId: string, workspaceSlug: string) {
    const { record } = await fx.apiKey(await wsId(workspaceSlug));
    return db().apiKey.update({ where: { id: record.id }, data: { createdBy: userId } });
  }

  const session = (userId: string, provider: string) =>
    db().refreshToken.create({
      data: {
        userId,
        provider,
        tokenHash: `t-${randomUUID()}`,
        familyId: randomUUID(),
        expiresAt: new Date(Date.now() + 3_600_000),
      },
    });

  beforeAll(async () => {
    app = await buildApp();
    await app.ready();
    fx = new Fixtures(app);
    alice = await fx.session(await fx.user());
    expect((await api(alice, 'POST', '/api/orgs', { name: 'Off', slug: org })).statusCode).toBe(
      201
    );
    for (const slug of [ws1, ws2]) {
      expect(
        (await api(alice, 'POST', `/api/orgs/${org}/workspaces`, { name: slug, slug })).statusCode
      ).toBe(201);
    }
    const organization = await db().organization.findUniqueOrThrow({ where: { slug: org } });
    // A workspace without Alice, for the last-owner case.
    await db().workspace.create({
      data: { slug: ws3, name: ws3, organizationId: organization.id },
    });
  });

  afterAll(async () => {
    await db().workspace.deleteMany({ where: { organization: { slug: org } } });
    await db().organization.deleteMany({ where: { slug: org } });
    await fx.cleanup();
    await app.close();
  });

  it("removes an org member from the org's workspaces, keys and org-SSO sessions", async () => {
    const { user: bob, memberId } = await orgUser();
    await fx.member(await wsId(ws1), bob.id, 'developer');
    await fx.member(await wsId(ws2), bob.id, 'owner'); // Alice owns ws2 too
    const key = await keyBy(bob.id, ws1);
    const orgKey = await db().orgApiKey.create({
      data: {
        organizationId: (await db().organization.findUniqueOrThrow({ where: { slug: org } })).id,
        name: 'bob ci',
        keyHash: 'x',
        workspaceScope: [],
        moduleScope: [],
        createdBy: bob.id,
      },
    });
    const orgSso = await session(bob.id, `org-oidc:${org}`);
    const github = await session(bob.id, 'github');

    const res = await api(alice, 'DELETE', `/api/orgs/${org}/members/${memberId}`);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      workspacesLeft: [ws1, ws2],
      keptAsLastOwner: [],
      apiKeysRevoked: 1,
      orgKeysRevoked: 1,
      ssoSessionsEnded: 1,
    });

    expect(await db().workspaceMember.count({ where: { userId: bob.id } })).toBe(0);
    expect(await db().organizationMember.count({ where: { userId: bob.id } })).toBe(0);
    expect(
      (await db().apiKey.findUniqueOrThrow({ where: { id: key.id } })).revokedAt
    ).not.toBeNull();
    expect(
      (await db().orgApiKey.findUniqueOrThrow({ where: { id: orgKey.id } })).revokedAt
    ).not.toBeNull();
    expect(
      (await db().refreshToken.findUniqueOrThrow({ where: { id: orgSso.id } })).revokedAt
    ).not.toBeNull();
    // Sessions from other sign-in methods aren't the organization's to end.
    expect(
      (await db().refreshToken.findUniqueOrThrow({ where: { id: github.id } })).revokedAt
    ).toBeNull();

    // Recorded in the workspace (as Alice) and in the org log with the effects.
    expect(
      await db().auditEvent.findFirst({
        where: { workspaceId: await wsId(ws1), action: 'member.remove', resourceId: bob.id },
      })
    ).toMatchObject({ actorType: 'user', metadata: { apiKeysRevoked: 1 } });
    expect(
      await db().organizationAuditEvent.findFirst({
        where: { action: 'org.member_remove', resourceId: memberId },
      })
    ).toMatchObject({ metadata: { workspacesLeft: [ws1, ws2], orgKeysRevoked: 1 } });
  });

  it("keeps a workspace's last owner and says so", async () => {
    const { user: carol, memberId } = await orgUser();
    await fx.member(await wsId(ws3), carol.id, 'owner');
    const res = await api(alice, 'DELETE', `/api/orgs/${org}/members/${memberId}`);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ workspacesLeft: [], keptAsLastOwner: [ws3] });
    expect(await db().workspaceMember.count({ where: { userId: carol.id, role: 'owner' } })).toBe(
      1
    );
  });

  it('keeps API keys with keepKeys=true', async () => {
    const { user: dave, memberId } = await orgUser();
    await fx.member(await wsId(ws1), dave.id, 'developer');
    const key = await keyBy(dave.id, ws1);
    const res = await api(alice, 'DELETE', `/api/orgs/${org}/members/${memberId}?keepKeys=true`);
    expect(res.json()).toMatchObject({ workspacesLeft: [ws1], apiKeysRevoked: 0 });
    expect((await db().apiKey.findUniqueOrThrow({ where: { id: key.id } })).revokedAt).toBeNull();
  });

  it("revokes a removed workspace member's keys unless keepKeys=true (PPL-05)", async () => {
    const id = await wsId(ws1);
    const [erin, frank] = await Promise.all([fx.user(), fx.user()]);
    const [erinMember, frankMember] = await Promise.all([
      fx.member(id, erin.id, 'developer'),
      fx.member(id, frank.id, 'developer'),
    ]);
    const [erinKey, frankKey] = await Promise.all([keyBy(erin.id, ws1), keyBy(frank.id, ws1)]);

    const W = `/api/workspaces/${ws1}/members`;
    expect((await api(alice, 'DELETE', `${W}/${erinMember.id}`)).statusCode).toBe(204);
    expect((await api(alice, 'DELETE', `${W}/${frankMember.id}?keepKeys=true`)).statusCode).toBe(
      204
    );
    expect(
      (await db().apiKey.findUniqueOrThrow({ where: { id: erinKey.id } })).revokedAt
    ).not.toBeNull();
    expect(
      (await db().apiKey.findUniqueOrThrow({ where: { id: frankKey.id } })).revokedAt
    ).toBeNull();
  });
});
