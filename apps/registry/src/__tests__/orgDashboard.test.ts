// Copyright The Harmoniq Authors
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'crypto';
import { FastifyInstance } from 'fastify';
import { buildApp } from '../app';
import { pseudonym } from '../services/auditActors';
import { Fixtures, bearer } from './helpers/fixtures';

// Phase 9.4: readable audit actors and filters (AUD-07/08), org key rotation (TAD-05),
// the paginated org home (TAD-06) and the catalog filters and consumers (TAD-07).
describe('Tenant admin dashboard APIs (Phase 9.4)', () => {
  let app: FastifyInstance;
  let fx: Fixtures;
  const run = randomUUID().slice(0, 8);
  const org = `dash-${run}`;
  let orgId: string;
  let alice: string; // org admin
  let aliceId: string;
  let aliceEmail: string;
  let alpha: { id: string; slug: string; hostAppId: string; moduleId: string };
  let beta: { id: string; slug: string; hostAppId: string; moduleId: string };

  type Method = 'GET' | 'POST';
  const api = (as: string, method: Method, url: string, payload?: object) =>
    app.inject({ method, url, payload, headers: bearer(as) });
  const db = () => app.container.systemDb;
  const env = (hostAppId: string, slug: string) =>
    db().environment.findFirstOrThrow({ where: { hostAppId, slug } });

  /** A workspace from the fixtures, moved into the organization and renamed. */
  async function orgWorkspace(name: string, moduleSlug: string) {
    const { workspace, hostApp } = await fx.workspace();
    await db().workspace.update({
      where: { id: workspace.id },
      data: { organizationId: orgId, name },
    });
    await db().remoteModule.deleteMany({ where: { workspaceId: workspace.id } });
    const module = await fx.module(workspace.id, hostApp.id, moduleSlug);
    return { id: workspace.id, slug: workspace.slug, hostAppId: hostApp.id, moduleId: module.id };
  }

  beforeAll(async () => {
    app = await buildApp();
    await app.ready();
    fx = new Fixtures(app);
    const user = await fx.user();
    aliceId = user.id;
    aliceEmail = user.email;
    alice = await fx.session(user);
    expect((await api(alice, 'POST', '/api/orgs', { name: org, slug: org })).statusCode).toBe(201);
    orgId = (await db().organization.findUniqueOrThrow({ where: { slug: org } })).id;
    alpha = await orgWorkspace(`Alpha ${run}`, `checkout-${run}`);
    beta = await orgWorkspace(`Beta ${run}`, `search-${run}`);
  });

  afterAll(async () => {
    await fx.cleanup();
    await db().organization.deleteMany({ where: { slug: org } });
    await app.close();
  });

  describe('audit actors and filters (AUD-07/08)', () => {
    it('labels users, workspace keys, org keys and erased users', async () => {
      const wsKey = await fx.apiKey(alpha.id);
      const orgKey = (
        await api(alice, 'POST', `/api/orgs/${org}/keys`, { name: 'terraform', scopes: ['admin'] })
      ).json();
      const erased = `erased-${run}`;
      const base = { workspaceId: alpha.id, resourceType: 'module', resourceId: alpha.moduleId };
      await db().auditEvent.createMany({
        data: [
          { ...base, actorType: 'user', actorId: aliceId, action: 'module.create' },
          { ...base, actorType: 'apiKey', actorId: wsKey.record.id, action: 'module.deploy' },
          { ...base, actorType: 'apiKey', actorId: orgKey.id, action: 'module.deploy' },
          { ...base, actorType: 'user', actorId: erased, action: 'module.update' },
          { ...base, actorType: 'system', actorId: 'alerts', action: 'module.rollback' },
        ],
      });

      const labels = (events: { actorId: string; actor: { label: string } }[]) =>
        Object.fromEntries(events.map((e) => [e.actorId, e.actor.label]));
      const { prefix } = await db().apiKey.findUniqueOrThrow({ where: { id: wsKey.record.id } });
      const expected = {
        [aliceId]: aliceEmail,
        [wsKey.record.id]: `test key (${prefix})`,
        [orgKey.id]: `terraform (${orgKey.prefix})`,
        [erased]: pseudonym(erased),
        alerts: 'alerts',
      };

      const ws = (await api(alice, 'GET', `/api/workspaces/${alpha.slug}/audit`)).json();
      expect(labels(ws.events)).toMatchObject(expected);
      expect(ws.events.find((e: { actorId: string }) => e.actorId === erased).actor).toEqual({
        type: 'user',
        id: erased,
        label: pseudonym(erased),
        deleted: true,
      });
      expect(pseudonym(erased)).toMatch(/^deleted user #[0-9a-f]{8}$/);

      const orgAudit = (
        await api(alice, 'GET', `/api/orgs/${org}/audit?workspace=${alpha.slug}`)
      ).json();
      expect(labels(orgAudit.events)).toMatchObject(expected);
    });

    it('filters by actor email (any case) and rejects malformed dates', async () => {
      const ws = (
        await api(
          alice,
          'GET',
          `/api/workspaces/${alpha.slug}/audit?actor=${encodeURIComponent(aliceEmail.toUpperCase())}`
        )
      ).json();
      expect(ws.events.length).toBeGreaterThan(0);
      expect(ws.events.every((e: { actorId: string }) => e.actorId === aliceId)).toBe(true);

      const nobody = (
        await api(alice, 'GET', `/api/orgs/${org}/audit?actor=nobody-${run}@test.local`)
      ).json();
      expect(nobody.events).toEqual([]);

      expect(
        (await api(alice, 'GET', `/api/workspaces/${alpha.slug}/audit?from=yesterday`)).statusCode
      ).toBe(400);
      const future = new Date(Date.now() + 86_400_000).toISOString();
      expect(
        (await api(alice, 'GET', `/api/workspaces/${alpha.slug}/audit?from=${future}`)).json()
          .events
      ).toEqual([]);
    });

    it('labels and filters the instance audit log', async () => {
      const root = await fx.user({ instanceAdmin: true });
      const session = await fx.session(root);
      await db().instanceAuditEvent.create({
        data: {
          actorType: 'user',
          actorId: root.id,
          action: `instance.test_${run}`,
          resourceType: 'instance',
          resourceId: 'instance',
        },
      });
      const res = (
        await api(session, 'GET', `/api/admin/audit?actor=${encodeURIComponent(root.email)}`)
      ).json();
      expect(res.events).toHaveLength(1);
      expect(res.events[0]).toMatchObject({
        action: `instance.test_${run}`,
        actor: { type: 'user', label: root.email, deleted: false },
      });
      const byAction = (
        await api(session, 'GET', `/api/admin/audit?action=instance.test_${run}`)
      ).json();
      expect(byAction.events).toHaveLength(1);
      await db().instanceAuditEvent.deleteMany({ where: { action: `instance.test_${run}` } });
    });
  });

  describe('org key rotation (TAD-05)', () => {
    it('issues a new key; the old one works until the grace period ends', async () => {
      const created = (
        await api(alice, 'POST', `/api/orgs/${org}/keys`, { name: 'ci', scopes: ['admin'] })
      ).json();
      const probe = (key: string) => api(key, 'GET', `/api/workspaces/${alpha.slug}`);
      expect((await probe(created.key)).statusCode).toBe(200);

      const rotated = await api(alice, 'POST', `/api/orgs/${org}/keys/${created.id}/rotate`, {
        gracePeriodHours: 1,
      });
      expect(rotated.statusCode).toBe(201);
      const fresh = rotated.json();
      expect(fresh).toMatchObject({ name: 'ci', scopes: ['admin'], replaces: created.id });
      expect(fresh.key).not.toBe(created.key);
      expect((await probe(fresh.key)).statusCode).toBe(200);
      expect((await probe(created.key)).statusCode).toBe(200);
      expect(
        (await api(alice, 'POST', `/api/orgs/${org}/keys/${created.id}/rotate`)).statusCode
      ).toBe(409);

      const keys = (await api(alice, 'GET', `/api/orgs/${org}/keys`)).json().keys;
      const statusOf = (id: string) => keys.find((k: { id: string }) => k.id === id);
      expect(statusOf(created.id)).toMatchObject({ status: 'rotating' });
      expect(statusOf(fresh.id)).toMatchObject({
        status: 'active',
        createdBy: { id: aliceId, email: aliceEmail },
      });

      await db().orgApiKey.update({
        where: { id: created.id },
        data: { gracePeriodEnd: new Date(Date.now() - 1000) },
      });
      app.forgetApiKey(created.id);
      expect((await probe(created.key)).statusCode).toBe(401);
      expect((await probe(fresh.key)).statusCode).toBe(200);
    });

    it('flags keys unused for 90 days', async () => {
      const idle = (
        await api(alice, 'POST', `/api/orgs/${org}/keys`, { name: 'idle', scopes: ['admin'] })
      ).json();
      await db().orgApiKey.update({
        where: { id: idle.id },
        data: { createdAt: new Date(Date.now() - 91 * 86_400_000) },
      });
      const keys = (await api(alice, 'GET', `/api/orgs/${org}/keys`)).json().keys;
      expect(keys.find((k: { id: string }) => k.id === idle.id).unused).toBe(true);
      expect(keys.filter((k: { unused: boolean }) => k.unused)).toHaveLength(1);
    });
  });

  describe('org home (TAD-06)', () => {
    it('paginates, searches and shows status per workspace', async () => {
      const staging = await env(beta.hostAppId, 'staging');
      await db().environment.update({
        where: { id: staging.id },
        data: { frozenAt: new Date(), frozenBy: aliceId },
      });
      await db().workspace.update({
        where: { id: beta.id },
        data: { suspendedAt: new Date(), suspendedReason: 'test' },
      });
      const production = await env(alpha.hostAppId, 'production');
      await db().deploymentRequest.create({
        data: {
          workspaceId: alpha.id,
          moduleId: alpha.moduleId,
          environmentId: production.id,
          type: 'deploy',
          requestedBy: aliceId,
          payload: {},
          status: 'pending_approval',
          expiresAt: new Date(Date.now() + 3_600_000),
        },
      });

      const first = (await api(alice, 'GET', `/api/orgs/${org}?limit=1`)).json();
      expect(first.total).toBe(2);
      expect(first.workspaces.map((w: { slug: string }) => w.slug)).toEqual([alpha.slug]);
      expect(first.workspaces[0]).toMatchObject({
        pendingApprovals: 1,
        suspended: false,
        frozenEnvironments: [],
      });
      expect(first.pendingApprovals).toEqual([
        expect.objectContaining({ workspace: alpha.slug, type: 'deploy' }),
      ]);
      const second = (
        await api(alice, 'GET', `/api/orgs/${org}?limit=1&cursor=${first.nextCursor}`)
      ).json();
      expect(second.workspaces[0]).toMatchObject({
        slug: beta.slug,
        suspended: true,
        frozenEnvironments: ['portal/staging'],
        pendingApprovals: 0,
      });
      expect(second.nextCursor).toBeNull();

      const found = (await api(alice, 'GET', `/api/orgs/${org}?query=beta`)).json();
      expect(found.workspaces.map((w: { slug: string }) => w.slug)).toEqual([beta.slug]);

      await db().workspace.update({ where: { id: beta.id }, data: { suspendedAt: null } });
    });
  });

  describe('catalog (TAD-07)', () => {
    it('searches, filters, paginates and lists consumers of shared modules', async () => {
      const production = await env(alpha.hostAppId, 'production');
      await db().remoteModule.update({ where: { id: alpha.moduleId }, data: { orgShared: true } });
      await db().moduleVersion.create({
        data: {
          workspaceId: alpha.id,
          remoteModuleId: alpha.moduleId,
          environmentId: production.id,
          version: '1.0.0',
          url: 'https://cdn.example.test/checkout.js',
          integrity: 'sha384-x',
          status: 'active',
          deployedBy: 'test',
          deployedByType: 'user',
        },
      });
      const slugs = async (qs: string) =>
        (await api(alice, 'GET', `/api/orgs/${org}/modules?${qs}`))
          .json()
          .modules.map((m: { slug: string }) => m.slug);

      expect(await slugs('')).toEqual([`checkout-${run}`, `search-${run}`]);
      expect(await slugs('query=CHECK')).toEqual([`checkout-${run}`]);
      expect(await slugs('shared=false')).toEqual([`search-${run}`]);
      expect(await slugs(`workspace=${beta.slug}`)).toEqual([`search-${run}`]);
      expect(await slugs('environment=production')).toEqual([`checkout-${run}`]);
      const page = (await api(alice, 'GET', `/api/orgs/${org}/modules?limit=1`)).json();
      expect(page).toMatchObject({ total: 2, nextCursor: alpha.moduleId });
      expect(await slugs(`limit=1&cursor=${page.nextCursor}`)).toEqual([`search-${run}`]);

      const consumers = (
        await api(alice, 'GET', `/api/orgs/${org}/modules/${alpha.moduleId}/consumers`)
      ).json();
      expect(consumers).toMatchObject({
        shared: true,
        consumers: [{ workspace: beta.slug, environments: ['portal/production'] }],
      });
      expect(
        (await api(alice, 'GET', `/api/orgs/${org}/modules/${beta.moduleId}/consumers`)).json()
          .consumers
      ).toEqual([]);
      expect((await api(alice, 'GET', `/api/orgs/${org}/modules/nope/consumers`)).statusCode).toBe(
        404
      );
    });
  });
});
