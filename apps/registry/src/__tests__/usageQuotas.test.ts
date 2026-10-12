// Copyright The Harmoniq Authors
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'crypto';
import { FastifyInstance } from 'fastify';
import { buildApp } from '../app';
import { Plans } from '../services/plans';
import { expirePlans } from '../services/planChanges';
import { usageDay } from '../services/usage';
import { Fixtures, bearer } from './helpers/fixtures';

const ENV = {
  HARMONIQ_PLAN_ENFORCEMENT: '1',
  HARMONIQ_PLAN_LIMITS: JSON.stringify({
    hobby: {
      workspaces: 1,
      members: 3,
      modules: 3,
      environmentsPerHostApp: 3,
      storageGb: 1,
      deploysPerMonth: 3,
      webhooks: 1,
    },
  }),
};

/** Sets env vars for one app build, and puts them back. */
async function withEnv<T>(env: Record<string, string>, fn: () => Promise<T>) {
  const saved = Object.fromEntries(Object.keys(env).map((k) => [k, process.env[k]]));
  Object.assign(process.env, env);
  try {
    return await fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

describe('Quotas, plan overrides and usage (PLN-04..06, USG-01..04)', () => {
  let app: FastifyInstance;
  let fx: Fixtures;
  let root: string;
  let owner: string;
  let ws: string;
  let workspaceId: string;
  let key: string;
  const run = randomUUID().slice(0, 8);
  const org = `quota-${run}`;

  type Method = 'GET' | 'POST' | 'PUT' | 'PATCH';
  const api = (as: string, method: Method, url: string, payload?: object) =>
    app.inject({ method, url, payload, headers: bearer(as) });
  const db = () => app.container.systemDb;
  const W = () => `/api/workspaces/${ws}`;
  const deploy = (version: string, extra: object = {}) =>
    api(key, 'POST', `${W()}/modules/checkout/deploy`, {
      environment: 'staging',
      url: `https://cdn.example.com/checkout/${version}.js`,
      version,
      integrity: 'sha384-abc',
      ...extra,
    });
  const audits = (action: string) =>
    db().auditEvent.findMany({ where: { workspaceId, action }, orderBy: { createdAt: 'asc' } });

  beforeAll(async () => {
    app = await withEnv(ENV, () => buildApp());
    await app.ready();
    fx = new Fixtures(app);
    const [r, o] = await Promise.all([fx.user({ instanceAdmin: true }), fx.user()]);
    [root, owner] = await Promise.all([fx.session(r), fx.session(o)]);
    const { workspace } = await fx.workspace();
    ws = workspace.slug;
    workspaceId = workspace.id;
    await fx.member(workspace.id, o.id, 'owner');
    key = (await fx.apiKey(workspace.id, { scopes: ['deploy:write'] })).raw;
  });

  afterAll(async () => {
    await db().usageDaily.deleteMany({ where: { workspaceId } });
    await db().workspace.deleteMany({ where: { organization: { slug: org } } });
    await db().organization.deleteMany({ where: { slug: org } });
    await fx.cleanup();
    await app.close();
  });

  it('refuses creates past a quota with 402, and warns at 80% (PLN-04/05, USG-04)', async () => {
    const createModule = (slug: string) =>
      api(owner, 'POST', `${W()}/modules`, { hostApp: 'portal', name: slug, slug });
    // The fixture has one module; the limit is 3.
    expect((await createModule('cart')).statusCode).toBe(201);
    expect((await createModule('search')).statusCode).toBe(201);
    const refused = await createModule('profile');
    expect(refused.statusCode).toBe(402);
    expect(refused.json().error).toMatchObject({
      code: 'QUOTA_EXCEEDED',
      details: { quota: 'modules', limit: 3, used: 3, plan: 'hobby' },
    });
    // 2 → 3 of 3 crossed 80% once.
    expect((await audits('quota.warning')).map((e) => e.resourceId)).toEqual(['modules']);
    expect((await audits('quota.exceeded')).map((e) => e.resourceId)).toEqual(['modules']);

    // Environments per host app (portal has staging and production).
    const env = (slug: string) =>
      api(owner, 'POST', `${W()}/host-apps/portal/environments`, { name: slug, slug });
    expect((await env('qa')).statusCode).toBe(201);
    expect((await env('uat')).json().error.details).toMatchObject({
      quota: 'environmentsPerHostApp',
      limit: 3,
    });

    // Webhooks.
    const hook = () =>
      api(owner, 'POST', `${W()}/webhooks`, { url: 'https://8.8.8.8/hook', events: ['*'] });
    expect((await hook()).statusCode).toBe(201);
    expect((await hook()).statusCode).toBe(402);

    // Seats: members and pending invitations (the owner is one).
    const invite = (n: number) =>
      api(owner, 'POST', `${W()}/members`, { email: `seat${n}-${run}@test.local`, role: 'viewer' });
    expect((await invite(1)).statusCode).toBe(201);
    expect((await invite(2)).statusCode).toBe(201);
    expect((await invite(3)).json().error.details).toMatchObject({ quota: 'members', used: 3 });
  });

  it('counts deploys per month and bundle storage (PLN-04, USG-02)', async () => {
    const big = 2 * 1024 ** 3;
    const tooBig = await deploy('9.9.9', { sizeBytes: big });
    expect(tooBig.statusCode).toBe(402);
    expect(tooBig.json().error.details).toMatchObject({ quota: 'storageGb', limit: 1 });

    const first = await deploy('1.0.0', { sizeBytes: 1234 });
    expect(first.statusCode).toBe(201);
    expect(
      (await db().moduleVersion.findUniqueOrThrow({ where: { id: first.json().id } })).sizeBytes
    ).toBe(1234n);
    expect((await deploy('1.0.1')).statusCode).toBe(201);
    expect((await deploy('1.0.2')).statusCode).toBe(201);
    const fourth = await deploy('1.0.3');
    expect(fourth.statusCode).toBe(402);
    expect(fourth.json().error.details).toMatchObject({ quota: 'deploysPerMonth', limit: 3 });
  });

  it('applies instance admin overrides and trials, then expires them (PLN-06)', async () => {
    const setPlan = (body: object) => api(root, 'PUT', `/api/admin/workspaces/${ws}/plan`, body);
    // Hobby has no approvals; an override grants them and lifts the deploy quota.
    const policy = () =>
      api(owner, 'PUT', `${W()}/host-apps/portal/environments/production/approval-policy`, {
        requiredApprovers: 1,
        eligibleRoles: ['admin', 'owner'],
      });
    expect((await policy()).statusCode).toBe(402);
    const overridden = await setPlan({
      plan: 'hobby',
      overrides: { features: { approvals: true }, limits: { deploysPerMonth: null } },
    });
    expect(overridden.json()).toMatchObject({
      plan: 'hobby',
      overrides: { limits: { deploysPerMonth: null } },
    });
    expect((await policy()).statusCode).toBe(200);
    expect((await deploy('1.0.3')).statusCode).toBe(201);
    const detail = (await api(owner, 'GET', W())).json();
    expect(detail.limits).toMatchObject({ deploysPerMonth: null, modules: 3 });

    // A trial of startup, which falls back to hobby.
    const until = new Date(Date.now() + 86_400_000).toISOString();
    const trial = await setPlan({ plan: 'startup', expiresAt: until });
    expect(trial.json()).toMatchObject({ plan: 'startup', basePlan: 'hobby', expiresAt: until });
    expect((await api(owner, 'GET', W())).json().plan).toBe('startup');
    expect((await audits('plan.changed')).at(-1)?.metadata).toMatchObject({
      from: 'hobby',
      to: 'startup',
      reason: 'admin',
    });

    await db().workspaceConfig.update({
      where: { workspaceId },
      data: { planExpiresAt: new Date(Date.now() - 1000) },
    });
    const expired = await expirePlans(app.container);
    expect(expired.workspaces).toBeGreaterThanOrEqual(1);
    const config = await db().workspaceConfig.findUniqueOrThrow({ where: { workspaceId } });
    expect(config).toMatchObject({ plan: 'hobby', planExpiresAt: null, basePlan: null });
    expect((await api(owner, 'GET', W())).json().plan).toBe('hobby');
    expect((await audits('plan.changed')).at(-1)?.metadata).toMatchObject({
      to: 'hobby',
      reason: 'expired',
    });
    expect(
      await db().instanceAuditEvent.count({
        where: { action: 'instance.plan_expired', resourceId: workspaceId },
      })
    ).toBe(1);
    expect(
      (await setPlan({ plan: 'startup', expiresAt: new Date(Date.now() - 1).toISOString() }))
        .statusCode
    ).toBe(400);
  });

  it('limits nothing without plan enforcement (PLN-02)', async () => {
    const plans = new Plans({
      systemDb: db(),
      config: { ...app.config, plans: { ...app.config.plans, enforced: false } },
    });
    const e = await plans.forWorkspace({ id: workspaceId });
    expect(Object.values(e.limits).every((v) => v === null)).toBe(true);
    expect(Object.values(e.features).every(Boolean)).toBe(true);
  });

  it("limits an organization's workspaces (PLN-04)", async () => {
    const admin = await fx.user();
    const as = await fx.session(admin);
    await api(as, 'POST', '/api/orgs', { name: org, slug: org });
    const create = (slug: string) =>
      api(as, 'POST', `/api/orgs/${org}/workspaces`, { name: slug, slug });
    expect((await create(`${org}-a`)).statusCode).toBe(201);
    const second = await create(`${org}-b`);
    expect(second.statusCode).toBe(402);
    expect(second.json().error.details).toMatchObject({ quota: 'workspaces', limit: 1 });
  });

  it('meters served manifests (304s and cache hits included) and flushes additively (USG-01)', async () => {
    const usage = app.container.usage;
    await usage.flush();
    const row = () =>
      db().usageDaily.findUnique({
        where: { workspaceId_day: { workspaceId, day: new Date(usageDay()) } },
      });
    const before = Number((await row())?.manifestRequests ?? 0);

    const url = `/api/manifest/${ws}/portal/staging`;
    const first = await app.inject({ method: 'GET', url });
    expect(first.statusCode).toBe(200);
    const again = await app.inject({
      method: 'GET',
      url,
      headers: { 'if-none-match': first.headers.etag as string },
    });
    expect(again.statusCode).toBe(304);
    // Not served: not counted.
    await app.inject({ method: 'GET', url: `/api/manifest/${ws}/portal/nope` });

    // Counting while flushes run: nothing is lost or counted twice.
    const extra = 200;
    await Promise.all(
      Array.from({ length: extra }, async (_, i) => {
        usage.manifestServed(ws);
        if (i % 50 === 0) await usage.flush();
      })
    );
    await usage.flush();
    expect(Number((await row())!.manifestRequests) - before).toBe(2 + extra);
    expect((await row())!.deploys).toBeGreaterThanOrEqual(4);
  });

  it('snapshots storage, members and keys nightly (USG-01/02)', async () => {
    await app.container.usage.snapshot();
    const row = await db().usageDaily.findUniqueOrThrow({
      where: { workspaceId_day: { workspaceId, day: new Date(usageDay()) } },
    });
    expect(row).toMatchObject({ storageBytes: 1234n, members: 1 });
    expect(row.apiKeys).toBeGreaterThanOrEqual(1);
  });

  it('reports usage to admins, billing members and instance admins, with CSV (USG-03)', async () => {
    const mine = await api(owner, 'GET', `${W()}/usage?days=7`);
    expect(mine.statusCode).toBe(200);
    expect(mine.json().workspace).toMatchObject({
      slug: ws,
      plan: 'hobby',
      // Seats: the owner and two pending invitations.
      current: { modules: 3, storageBytes: 1234, webhooks: 1, members: 3 },
      limits: { modules: 3 },
    });
    expect(mine.json().workspace.daily.at(-1).day).toBe(usageDay());
    expect((await api(owner, 'GET', `${W()}/usage?days=0`)).statusCode).toBe(400);

    const csv = await api(owner, 'GET', `${W()}/usage?format=csv`);
    expect(csv.headers['content-type']).toContain('text/csv');
    expect(csv.body.split('\n')[0]).toBe(
      'workspace,day,manifestRequests,deploys,healthEvents,storageBytes,members,apiKeys'
    );

    // Organizations: admins, billing and auditors read it; members don't.
    const admin = (
      await db().organizationMember.findFirstOrThrow({
        where: { organization: { slug: org }, role: 'org_admin' },
        include: { user: true },
      })
    ).user;
    const as = await fx.session(admin);
    const [billing, member] = await Promise.all([fx.user(), fx.user()]);
    await api(as, 'POST', `/api/orgs/${org}/members`, {
      email: billing.email,
      role: 'org_billing',
    });
    await api(as, 'POST', `/api/orgs/${org}/members`, { email: member.email });
    const orgUsage = await api(await fx.session(billing), 'GET', `/api/orgs/${org}/usage`);
    expect(orgUsage.statusCode).toBe(200);
    expect(orgUsage.json()).toMatchObject({
      plan: 'hobby',
      limits: { workspaces: 1 },
      totals: { workspaces: 1 },
    });
    expect((await api(await fx.session(member), 'GET', `/api/orgs/${org}/usage`)).statusCode).toBe(
      403
    );

    const all = await api(root, 'GET', '/api/admin/usage?days=1');
    expect(all.statusCode).toBe(200);
    expect(all.json().totals.workspaces).toBeGreaterThan(0);
    const listed = (await api(root, 'GET', `/api/admin/workspaces?query=${ws}`)).json();
    expect(listed.workspaces[0]).toMatchObject({ slug: ws, storageBytes: 1234 });
  });
});

describe('Per-tenant rate limits (MT-12)', () => {
  it('shares one budget per workspace across credentials, by plan', async () => {
    const app = await withEnv(
      { HARMONIQ_API_RATE_LIMIT: '3', HARMONIQ_PLAN_ENFORCEMENT: '1' },
      () => buildApp()
    );
    await app.ready();
    const fx = new Fixtures(app);
    try {
      const [a, b] = await Promise.all([fx.workspace(), fx.workspace()]);
      const user = await fx.user();
      await fx.member(a.workspace.id, user.id, 'owner');
      await fx.member(b.workspace.id, user.id, 'owner');
      const session = await fx.session(user);
      const key = (await fx.apiKey(a.workspace.id, { scopes: ['admin'] })).raw;
      const write = (as: string, slug: string) =>
        app.inject({
          method: 'PATCH',
          url: `/api/workspaces/${slug}`,
          headers: bearer(as),
          payload: { retentionDays: 90 },
        });
      // Session and key share workspace A's budget of 3.
      expect((await write(session, a.workspace.slug)).statusCode).toBe(200);
      expect((await write(key, a.workspace.slug)).statusCode).not.toBe(429);
      expect((await write(session, a.workspace.slug)).statusCode).toBe(200);
      const limited = await write(key, a.workspace.slug);
      expect(limited.statusCode).toBe(429);
      // Workspace B has its own.
      expect((await write(session, b.workspace.slug)).statusCode).toBe(200);
    } finally {
      await fx.cleanup();
      await app.close();
    }
  });
});
