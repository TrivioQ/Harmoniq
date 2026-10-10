import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'crypto';
import { FastifyInstance } from 'fastify';
import { buildApp } from '../app';
import { Fixtures, bearer } from './helpers/fixtures';

describe('Plans and limits (M4.11, PLN-01..03, RL-04)', () => {
  let app: FastifyInstance;
  let fx: Fixtures;
  let root: string;
  let owner: string;
  let ws: string;
  let workspaceId: string;
  const env = {
    HARMONIQ_PLAN_ENFORCEMENT: '1',
    HARMONIQ_MANIFEST_RATE_LIMIT: '2',
    HARMONIQ_MANIFEST_RATE_LIMIT_STARTUP: '4',
  };
  const saved: Record<string, string | undefined> = {};
  const org = `plan-${randomUUID().slice(0, 8)}`;

  const api = (as: string, method: 'GET' | 'POST' | 'PUT', url: string, payload?: object) =>
    app.inject({ method, url, payload, headers: bearer(as) });
  const policy = () =>
    api(
      owner,
      'PUT',
      `/api/workspaces/${ws}/host-apps/portal/environments/production/approval-policy`,
      { requiredApprovers: 1, eligibleRoles: ['admin', 'owner'] }
    );
  const setPlan = (plan: string) => api(root, 'PUT', `/api/admin/workspaces/${ws}/plan`, { plan });
  const manifestBurst = async (n: number) => {
    const codes: number[] = [];
    for (let i = 0; i < n; i++) {
      codes.push(
        (await app.inject({ method: 'GET', url: `/api/manifest/${ws}/portal/production` }))
          .statusCode
      );
    }
    return codes;
  };

  beforeAll(async () => {
    for (const [k, v] of Object.entries(env)) {
      saved[k] = process.env[k];
      process.env[k] = v;
    }
    app = await buildApp();
    await app.ready();
    fx = new Fixtures(app);
    const [r, o] = await Promise.all([fx.user({ instanceAdmin: true }), fx.user()]);
    [root, owner] = await Promise.all([fx.session(r), fx.session(o)]);
    const { workspace } = await fx.workspace();
    ws = workspace.slug;
    workspaceId = workspace.id;
    await fx.member(workspace.id, o.id, 'owner');
  });

  afterAll(async () => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    await app.container.systemDb.workspace.updateMany({
      where: { id: workspaceId },
      data: { organizationId: null },
    });
    await app.container.systemDb.organization.deleteMany({ where: { slug: org } });
    await fx.cleanup();
    await app.close();
  });

  it('gates features on the hobby plan with 402 and the plan needed (PLN-03)', async () => {
    const approvals = await policy();
    expect(approvals.statusCode).toBe(402);
    expect(approvals.json().error).toMatchObject({
      code: 'PLAN_REQUIRED',
      details: { feature: 'approvals', plan: 'hobby', requiredPlan: 'startup' },
    });
    const storage = await api(owner, 'POST', `/api/workspaces/${ws}/storage`, {
      provider: 'S3',
      bucket: 'b',
      region: 'r',
      credentials: { accessKeyId: 'a', secretAccessKey: 'b' },
    });
    expect(storage.json().error.details).toMatchObject({ feature: 'byob' });
    const scim = await api(owner, 'POST', `/api/workspaces/${ws}/scim/token`);
    expect(scim.json().error.details).toMatchObject({
      feature: 'scim',
      requiredPlan: 'enterprise',
    });
    const gitops = await api(owner, 'POST', `/api/workspaces/${ws}/apply`, {
      dryRun: true,
      config: {
        version: 1,
        hostApps: [
          {
            slug: 'portal',
            environments: [{ slug: 'production', approvalPolicy: { eligibleRoles: ['admin'] } }],
          },
        ],
      },
    });
    expect(gitops.statusCode).toBe(402);

    const detail = (await api(owner, 'GET', `/api/workspaces/${ws}`)).json();
    expect(detail).toMatchObject({
      plan: 'hobby',
      features: { byob: false, approvals: false, saml: false, scim: false },
    });
  });

  it('instance admins set plans; features follow at once (PLN-01)', async () => {
    expect(
      (await api(owner, 'PUT', `/api/admin/workspaces/${ws}/plan`, { plan: 'enterprise' }))
        .statusCode
    ).toBe(403);
    expect((await setPlan('platinum')).statusCode).toBe(400);
    expect((await setPlan('startup')).json()).toEqual({ slug: ws, plan: 'startup' });
    expect((await policy()).statusCode).toBe(200);
    expect(
      (await api(owner, 'POST', `/api/workspaces/${ws}/scim/token`)).json().error.details
    ).toMatchObject({ feature: 'scim', plan: 'startup' });
    const listed = (await api(root, 'GET', `/api/admin/workspaces?query=${ws}`)).json();
    expect(listed.workspaces[0]).toMatchObject({ plan: 'startup' });
  });

  it("uses the organization's plan when it is higher", async () => {
    await api(owner, 'POST', '/api/orgs', { name: 'Plan Org', slug: org });
    expect((await api(owner, 'POST', `/api/orgs/${org}/workspaces/${ws}/attach`)).statusCode).toBe(
      200
    );
    expect(
      (await api(root, 'PUT', `/api/admin/orgs/${org}/plan`, { plan: 'enterprise' })).statusCode
    ).toBe(200);
    const token = await api(owner, 'POST', `/api/workspaces/${ws}/scim/token`);
    expect(token.statusCode).toBe(200);
    expect((await api(owner, 'GET', `/api/workspaces/${ws}`)).json().plan).toBe('enterprise');
    const orgs = (await api(root, 'GET', '/api/admin/orgs')).json().organizations;
    expect(orgs.find((o: { slug: string }) => o.slug === org)).toMatchObject({
      plan: 'enterprise',
    });
    // Back to the workspace's own plan.
    await api(root, 'PUT', `/api/admin/orgs/${org}/plan`, { plan: 'hobby' });
  });

  it('raises the manifest rate limit by plan (RL-04)', async () => {
    await setPlan('hobby');
    expect(await manifestBurst(3)).toEqual([200, 200, 429]);
    // A fresh workspace on startup: 4 per minute.
    const { workspace } = await fx.workspace();
    ws = workspace.slug;
    await setPlan('startup');
    expect(await manifestBurst(5)).toEqual([200, 200, 200, 200, 429]);
  });
});
