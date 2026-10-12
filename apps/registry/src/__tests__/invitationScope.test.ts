// Copyright The Harmoniq Authors
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'crypto';
import { FastifyInstance } from 'fastify';
import { buildApp } from '../app';
import { AuthService } from '../services/authService';
import { Fixtures } from './helpers/fixtures';

// PPL-02 (gap analysis P1-9): a sign-in accepts only the invitations its session can reach.
describe('Invitation acceptance by sign-in method (PPL-02)', () => {
  let app: FastifyInstance;
  let fx: Fixtures;
  let auth: AuthService;
  const run = randomUUID().slice(0, 8);
  const org = `inv-${run}`;
  const email = `invitee-${run}@test.local`;
  const ws = { solo: '', inherits: '', ownSso: '', other: '' };
  let userId = '';

  const db = () => app.container.systemDb;
  const joined = async () =>
    (
      await db().workspaceMember.findMany({
        where: { userId, joinedAt: { not: null } },
        include: { workspace: { select: { slug: true } } },
      })
    )
      .map((m) => m.workspace.slug)
      .sort();
  const signIn = (provider: string) =>
    auth.completeLogin(
      { providerUserId: `${provider}-${run}`, email, emailVerified: true },
      provider
    );

  beforeAll(async () => {
    app = await buildApp();
    await app.ready();
    fx = new Fixtures(app);
    auth = new AuthService(db(), app.config.jwtSecret, app.container.logger);
    const organization = await db().organization.create({ data: { slug: org, name: org } });
    const make = async (slug: string, organizationId?: string) =>
      (
        await db().workspace.create({
          data: { slug: `${org}-${slug}`, name: slug, organizationId },
        })
      ).slug;
    ws.solo = await make('solo');
    ws.inherits = await make('inherits', organization.id);
    ws.ownSso = await make('own', organization.id);
    ws.other = await make('other');
    const own = await db().workspace.findUniqueOrThrow({ where: { slug: ws.ownSso } });
    await db().workspaceConfig.create({
      data: { workspaceId: own.id, samlConfig: { idpEntityId: 'x' } },
    });
    const user = await db().user.create({ data: { email } });
    userId = user.id;
    for (const slug of Object.values(ws)) {
      const w = await db().workspace.findUniqueOrThrow({ where: { slug } });
      await fx.member(w.id, user.id, 'developer', { joined: false });
    }
  });

  afterAll(async () => {
    await db().workspace.deleteMany({ where: { slug: { startsWith: `${org}-` } } });
    await db().organization.deleteMany({ where: { slug: org } });
    await db().user.deleteMany({ where: { email } });
    await fx.cleanup();
    await app.close();
  });

  it("a workspace's SSO accepts only that workspace's invitation", async () => {
    await signIn(`saml:${ws.solo}`);
    expect(await joined()).toEqual([ws.solo]);
  });

  it("an organization's SSO accepts invitations to its workspaces that use it", async () => {
    await signIn(`org-oidc:${org}`);
    // Not the workspace with its own SSO, and nothing outside the organization.
    expect(await joined()).toEqual([ws.inherits, ws.solo].sort());
  });

  it('an instance-wide method accepts every invitation', async () => {
    await signIn('github');
    expect(await joined()).toEqual(Object.values(ws).sort());
  });
});
