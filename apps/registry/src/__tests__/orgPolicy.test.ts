// Copyright The Harmoniq Authors
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'crypto';
import { FastifyInstance } from 'fastify';
import type { SessionResponse } from '@harmoniq/core/dist/schemas/AuthSchemas';
import { buildApp } from '../app';
import { AuthService } from '../services/authService';
import { effectiveSso } from '../services/ssoIds';
import {
  activeOrgFreeze,
  effectiveApproval,
  ipAllowed,
  keyPolicyViolations,
  matchesPattern,
  weakerThan,
} from '../services/policy';
import { Fixtures, bearer } from './helpers/fixtures';

const rule = (over: object = {}) => ({
  requiredApprovers: 2,
  eligibleRoles: ['admin', 'owner'],
  requireChangeTicket: false,
  ticketUrlPattern: null,
  expiryHours: 24,
  ...over,
});

describe('Organization policy: resolution (POL-02..08)', () => {
  it('matches environment patterns', () => {
    expect(matchesPattern('production', 'production')).toBe(true);
    expect(matchesPattern('prod-*', 'prod-eu')).toBe(true);
    expect(matchesPattern('prod-*', 'production')).toBe(false);
    expect(matchesPattern('*', 'anything')).toBe(true);
    expect(matchesPattern('a.b', 'axb')).toBe(false);
  });

  it('takes the strictest of the workspace and org approval rules', () => {
    const org = rule({ requireChangeTicket: true, expiryHours: 12 });
    expect(weakerThan(rule({ requiredApprovers: 1, eligibleRoles: ['developer'] }), org)).toEqual([
      'needs at least 2 approvers',
      'roles not allowed to approve: developer',
      'must require a change ticket',
      'requests must expire within 12 hours',
    ]);
    expect(
      weakerThan(
        rule({
          requiredApprovers: 3,
          eligibleRoles: ['owner'],
          requireChangeTicket: true,
          expiryHours: 6,
        }),
        org
      )
    ).toEqual([]);
    expect(effectiveApproval(null, org)).toEqual({ rule: org, source: 'organization' });
    expect(effectiveApproval(rule({ requiredApprovers: 1 }), null)?.source).toBe('workspace');
    // A policy saved before the default is tightened, never loosened.
    expect(
      effectiveApproval(
        rule({ requiredApprovers: 1, eligibleRoles: ['developer', 'owner'], expiryHours: 48 }),
        org
      )
    ).toEqual({
      rule: rule({
        requiredApprovers: 2,
        eligibleRoles: ['owner'],
        requireChangeTicket: true,
        expiryHours: 12,
      }),
      source: 'organization',
    });
  });

  it('checks keys, freeze windows and IP addresses', () => {
    const policy = {
      maxApiKeyDays: 30,
      allowedKeyScopes: ['deploy:write'],
      freezeWindows: [
        {
          id: 'w1',
          environmentPattern: 'prod*',
          reason: 'holidays',
          until: '2999-01-01T00:00:00Z',
        },
      ],
    } as never;
    const now = Date.now();
    expect(keyPolicyViolations(policy, { scopes: ['admin'], expiresAt: null })).toEqual([
      'scopes not allowed: admin',
      'must expire within 30 days',
    ]);
    expect(
      keyPolicyViolations(policy, {
        scopes: ['deploy:write'],
        expiresAt: new Date(now + 86_400_000),
      })
    ).toEqual([]);
    expect(activeOrgFreeze(policy, 'production')?.window.id).toBe('w1');
    expect(activeOrgFreeze(policy, 'staging')).toBeNull();

    expect(ipAllowed([], '1.2.3.4')).toBe(true);
    expect(ipAllowed(['10.0.0.0/8', '2001:db8::/32'], '10.1.2.3')).toBe(true);
    expect(ipAllowed(['10.0.0.0/8'], '::ffff:10.1.2.3')).toBe(true);
    expect(ipAllowed(['10.0.0.0/8', '2001:db8::/32'], '2001:db8::1')).toBe(true);
    expect(ipAllowed(['10.0.0.0/8'], '11.0.0.1')).toBe(false);
    expect(ipAllowed(['192.168.1.5'], '192.168.1.5')).toBe(true);
  });
});

describe('Organization policy (POL-01..09)', () => {
  let app: FastifyInstance;
  let fx: Fixtures;
  const run = randomUUID().slice(0, 8);
  const org = `pol-${run}`;
  let orgId: string;
  let alice: string; // org admin
  let aliceId: string;
  let owner: string; // workspace owner, org member
  let ownerId: string;
  let ownerEmail: string;
  let ws: string;
  let workspaceId: string;
  let key: string;

  type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  const api = (
    as: string,
    method: Method,
    url: string,
    payload?: object,
    extra: { remoteAddress?: string } = {}
  ) => app.inject({ method, url, payload, headers: bearer(as), ...extra });
  const db = () => app.container.systemDb;
  const setPolicy = (policy: object) => api(alice, 'PUT', `/api/orgs/${org}/policy`, policy);
  const deploy = (as: string, version: string, env = 'production') =>
    api(as, 'POST', `/api/workspaces/${ws}/modules/checkout/deploy`, {
      environment: env,
      url: `https://cdn.example.com/checkout/${version}.js`,
      version,
      integrity: 'sha384-abc',
    });
  const approvalUrl = (env = 'production') =>
    `/api/workspaces/${ws}/host-apps/portal/environments/${env}/approval-policy`;

  beforeAll(async () => {
    app = await buildApp();
    await app.ready();
    fx = new Fixtures(app);
    const a = await fx.user();
    aliceId = a.id;
    alice = await fx.session(a);
    expect((await api(alice, 'POST', '/api/orgs', { name: org, slug: org })).statusCode).toBe(201);
    orgId = (await db().organization.findUniqueOrThrow({ where: { slug: org } })).id;
    const { workspace } = await fx.workspace();
    ws = workspace.slug;
    workspaceId = workspace.id;
    await db().workspace.update({ where: { id: workspaceId }, data: { organizationId: orgId } });
    const o = await fx.user();
    ownerId = o.id;
    ownerEmail = o.email;
    owner = await fx.session(o);
    await fx.member(workspaceId, o.id, 'owner');
    await api(alice, 'POST', `/api/orgs/${org}/members`, { email: o.email });
    key = (await fx.apiKey(workspaceId, { scopes: ['deploy:write'] })).raw;
  });

  afterAll(async () => {
    await fx.cleanup();
    await db().organization.deleteMany({ where: { slug: org } });
    await app.close();
  });

  it('is read by admins and auditors, written by admins, and audited field by field (POL-01)', async () => {
    const empty = (await api(alice, 'GET', `/api/orgs/${org}/policy`)).json();
    expect(empty).toMatchObject({ approvalDefaults: [], lockSso: false, ipAllowlist: [] });
    expect((await api(owner, 'GET', `/api/orgs/${org}/policy`)).statusCode).toBe(403);
    expect((await api(owner, 'PUT', `/api/orgs/${org}/policy`, {})).statusCode).toBe(403);
    expect((await setPolicy({ ipAllowlist: ['not-an-ip'] })).statusCode).toBe(400);
    expect((await setPolicy({ ipAllowlist: ['10.0.0.0/33'] })).statusCode).toBe(400);

    const saved = await setPolicy({ minRetentionDays: 30 });
    expect(saved.statusCode).toBe(200);
    expect(saved.json()).toMatchObject({ minRetentionDays: 30, updatedBy: aliceId });
    const event = await db().organizationAuditEvent.findFirstOrThrow({
      where: { organizationId: orgId, action: 'org.policy_updated' },
      orderBy: { createdAt: 'desc' },
    });
    expect(event.metadata).toEqual({ changes: { minRetentionDays: { before: null, after: 30 } } });
    // Saving the same policy again changes nothing and records nothing.
    await setPolicy({ minRetentionDays: 30 });
    expect(
      await db().organizationAuditEvent.count({
        where: { organizationId: orgId, action: 'org.policy_updated' },
      })
    ).toBe(1);
  });

  it('applies approval defaults and refuses weaker workspace policies (POL-02)', async () => {
    expect((await deploy(key, '1.0.0')).statusCode).toBe(201);
    await setPolicy({
      approvalDefaults: [
        { environmentPattern: 'prod*', requiredApprovers: 2, eligibleRoles: ['admin', 'owner'] },
      ],
    });
    // No workspace policy: the org default applies.
    const pending = await deploy(key, '1.1.0');
    expect(pending.statusCode).toBe(202);
    expect(pending.json()).toMatchObject({ status: 'pending_approval', requiredApprovers: 2 });
    // Other environments are not affected.
    expect((await deploy(key, '1.1.0', 'staging')).statusCode).toBe(201);

    const weaker = await api(owner, 'PUT', approvalUrl(), {
      requiredApprovers: 1,
      eligibleRoles: ['developer', 'admin'],
    });
    expect(weaker.statusCode).toBe(409);
    expect(weaker.json().error.code).toBe('POLICY_VIOLATION');
    expect(
      (await api(owner, 'PUT', approvalUrl(), { requiredApprovers: 3, eligibleRoles: ['owner'] }))
        .statusCode
    ).toBe(200);

    const effective = (await api(owner, 'GET', `/api/workspaces/${ws}/policy`)).json();
    expect(
      effective.approvals.find((a: { environment: string }) => a.environment === 'production')
    ).toMatchObject({
      policy: { requiredApprovers: 3, eligibleRoles: ['owner'] },
      source: 'workspace',
      locked: true,
    });
    expect(
      effective.approvals.find((a: { environment: string }) => a.environment === 'staging')
    ).toMatchObject({ policy: null, source: null });

    // GitOps: the plan reports the violation before anything changes.
    const plan = await api(owner, 'POST', `/api/workspaces/${ws}/apply`, {
      dryRun: true,
      config: {
        version: 1,
        hostApps: [
          {
            slug: 'portal',
            name: 'Portal',
            environments: [
              {
                slug: 'production',
                name: 'Production',
                approvalPolicy: { requiredApprovers: 1, eligibleRoles: ['admin'] },
              },
            ],
          },
        ],
      },
    });
    expect(plan.statusCode, plan.body).toBe(422);
    expect(JSON.stringify(plan.json())).toContain(
      'portal/production: approval policy needs at least 2 approvers'
    );

    await db().deploymentRequest.deleteMany({ where: { workspaceId } });
    await db().approvalPolicy.deleteMany({ where: { workspaceId } });
    await setPolicy({ minRetentionDays: 30 });
  });

  it('limits key lifetime and scopes for workspace and org keys (POL-03)', async () => {
    await setPolicy({
      minRetentionDays: 30,
      maxApiKeyDays: 30,
      allowedKeyScopes: ['deploy:write', 'manifest:read'],
    });
    const soon = new Date(Date.now() + 7 * 86_400_000).toISOString();
    const late = new Date(Date.now() + 90 * 86_400_000).toISOString();
    const create = (body: object) => api(owner, 'POST', `/api/workspaces/${ws}/api-keys`, body);

    expect((await create({ name: 'forever', scopes: ['deploy:write'] })).statusCode).toBe(409);
    expect(
      (await create({ name: 'late', scopes: ['deploy:write'], expiresAt: late })).statusCode
    ).toBe(409);
    expect((await create({ name: 'admin', scopes: ['admin'], expiresAt: soon })).statusCode).toBe(
      409
    );
    const ok = await create({ name: 'ci', scopes: ['deploy:write'], expiresAt: soon });
    expect(ok.statusCode).toBe(201);

    // The fixture key (no expiry) predates the policy: flagged, not revoked.
    const keys = (await api(owner, 'GET', `/api/workspaces/${ws}/api-keys`)).json().keys;
    expect(keys.find((k: { name: string }) => k.name === 'test key').policyViolations).toEqual([
      'must expire within 30 days',
    ]);
    expect(keys.find((k: { id: string }) => k.id === ok.json().id).policyViolations).toEqual([]);

    // Rotating a key without expiry gives the new one the policy's maximum.
    const old = keys.find((k: { name: string }) => k.name === 'test key');
    const rotated = await api(owner, 'POST', `/api/workspaces/${ws}/api-keys/${old.id}/rotate`, {});
    expect(rotated.statusCode).toBe(201);
    const expires = new Date(rotated.json().expiresAt).getTime();
    expect(expires).toBeGreaterThan(Date.now() + 29 * 86_400_000);
    expect(expires).toBeLessThanOrEqual(Date.now() + 30 * 86_400_000);

    // Org keys follow the same policy.
    const orgKey = (body: object) => api(alice, 'POST', `/api/orgs/${org}/keys`, body);
    expect((await orgKey({ name: 'tf', scopes: ['admin'], expiresAt: soon })).statusCode).toBe(409);
    expect((await orgKey({ name: 'ci', scopes: ['deploy:write'] })).statusCode).toBe(409);
    expect(
      (await orgKey({ name: 'ci', scopes: ['deploy:write'], expiresAt: soon })).statusCode
    ).toBe(201);
    key = (await fx.apiKey(workspaceId, { scopes: ['deploy:write'] })).raw;
    await setPolicy({ minRetentionDays: 30 });
  });

  it('keeps retention above the floor (POL-04)', async () => {
    const patch = (days: number) =>
      api(owner, 'PATCH', `/api/workspaces/${ws}`, { retentionDays: days });
    const low = await patch(7);
    expect(low.statusCode).toBe(409);
    expect(low.json().error.code).toBe('POLICY_VIOLATION');
    expect((await patch(60)).statusCode).toBe(200);
    const effective = (await api(owner, 'GET', `/api/workspaces/${ws}/policy`)).json();
    expect(effective.retentionDays).toMatchObject({ value: 60, minimum: 30, source: 'workspace' });
  });

  it('freezes matching environments org-wide; only an org admin overrides (POL-05)', async () => {
    const saved = (
      await setPolicy({
        minRetentionDays: 30,
        freezeWindows: [{ environmentPattern: 'production', reason: 'Year-end freeze' }],
      })
    ).json();
    const windowId = saved.freezeWindows[0].id;
    const frozen = await deploy(key, '2.0.0');
    expect(frozen.statusCode).toBe(423);
    expect(frozen.json().error.message).toContain('frozen by the organization');
    expect((await deploy(key, '2.0.0', 'staging')).statusCode).toBe(201);

    const overrideUrl = `/api/orgs/${org}/policy/freeze-windows/${windowId}/override`;
    const until = new Date(Date.now() + 3_600_000).toISOString();
    expect((await api(owner, 'POST', overrideUrl, { until, reason: 'hotfix' })).statusCode).toBe(
      403
    );
    expect((await api(alice, 'POST', overrideUrl, { until, reason: 'hotfix' })).statusCode).toBe(
      200
    );
    expect((await deploy(key, '2.0.1')).statusCode).toBe(201);
    const deployEvent = await db().auditEvent.findFirstOrThrow({
      where: { workspaceId, action: 'module.deploy' },
      orderBy: { createdAt: 'desc' },
    });
    expect(deployEvent.metadata).toMatchObject({
      orgFreezeOverride: { window: windowId, reason: 'hotfix', by: aliceId },
    });
    // Saving the policy keeps the window and its override.
    const again = (
      await setPolicy({
        minRetentionDays: 30,
        freezeWindows: [
          { id: windowId, environmentPattern: 'production', reason: 'Year-end freeze' },
        ],
      })
    ).json();
    expect(again.freezeWindows[0].override).toMatchObject({ reason: 'hotfix' });

    expect((await api(alice, 'DELETE', overrideUrl)).statusCode).toBe(200);
    expect((await deploy(key, '2.0.2')).statusCode).toBe(423);
    expect(
      await db().organizationAuditEvent.count({
        where: {
          organizationId: orgId,
          action: { in: ['org.freeze_override', 'org.freeze_override_end'] },
        },
      })
    ).toBe(2);
    await setPolicy({ minRetentionDays: 30 });
  });

  it('locks workspace SSO to the organization (POL-06)', async () => {
    await db().workspaceConfig.upsert({
      where: { workspaceId },
      create: {
        workspaceId,
        oidcConfig: { issuer: 'https://idp.example.test', clientId: 'x', clientSecret: 'y' },
      },
      update: {
        oidcConfig: { issuer: 'https://idp.example.test', clientId: 'x', clientSecret: 'y' },
      },
    });
    const wsRow = { id: workspaceId, slug: ws, organizationId: orgId };
    expect((await effectiveSso(db(), wsRow)).subject).toEqual({ kind: 'workspace', slug: ws });

    await setPolicy({ minRetentionDays: 30, lockSso: true });
    expect((await effectiveSso(db(), wsRow)).subject).toBeNull();
    const put = await api(owner, 'PUT', `/api/workspaces/${ws}/sso/oidc`, {
      issuer: 'https://idp.example.test',
      clientId: 'x',
      clientSecret: 'y',
    });
    expect(put.statusCode).toBe(409);
    expect(put.json().error.code).toBe('POLICY_VIOLATION');
    await setPolicy({ minRetentionDays: 30 });
    await db().workspaceConfig.update({ where: { workspaceId }, data: { oidcConfig: undefined } });
  });

  it('ends sessions past the idle timeout or maximum lifetime at refresh (POL-07)', async () => {
    const auth = new AuthService(db(), app.config.jwtSecret, app.container.logger);
    const login = async () =>
      (await auth.completeLogin(
        { providerUserId: `gh-${randomUUID()}`, email: ownerEmail, emailVerified: true },
        'github'
      )) as SessionResponse;
    await setPolicy({ minRetentionDays: 30, idleTimeoutMinutes: 30, sessionMaxHours: 8 });

    const fresh = await login();
    expect(await auth.refresh(fresh.refreshToken)).not.toBeNull();

    const idle = await login();
    await db().refreshToken.updateMany({
      where: { userId: ownerId, usedAt: null, createdAt: { gte: new Date(Date.now() - 60_000) } },
      data: { createdAt: new Date(Date.now() - 31 * 60_000) },
    });
    expect(await auth.refresh(idle.refreshToken)).toBeNull();

    // Active all along, but the session began more than 8 hours ago.
    const long = await login();
    const family = (
      await db().refreshToken.findMany({
        where: { userId: ownerId },
        orderBy: { createdAt: 'desc' },
        take: 1,
      })
    )[0].familyId;
    await db().refreshToken.create({
      data: {
        userId: ownerId,
        familyId: family,
        tokenHash: `old-${randomUUID()}`,
        expiresAt: new Date(Date.now() + 86_400_000),
        usedAt: new Date(),
        createdAt: new Date(Date.now() - 9 * 3_600_000),
      },
    });
    expect(await auth.refresh(long.refreshToken)).toBeNull();
    await setPolicy({ minRetentionDays: 30 });
  });

  it('admits management access only from allowed networks (POL-08)', async () => {
    const inside = { remoteAddress: '203.0.113.9' };
    const save = (policy: object, extra = inside) =>
      api(alice, 'PUT', `/api/orgs/${org}/policy`, policy, extra);
    // Saving a list that leaves out your own address would lock you out.
    const lockout = await save(
      { ipAllowlist: ['203.0.113.0/24'] },
      { remoteAddress: '198.51.100.7' }
    );
    expect(lockout.statusCode).toBe(409);
    expect((await save({ minRetentionDays: 30, ipAllowlist: ['203.0.113.0/24'] })).statusCode).toBe(
      200
    );

    const from = (remoteAddress: string, as = owner) =>
      api(as, 'GET', `/api/workspaces/${ws}`, undefined, { remoteAddress });
    const denied = await from('198.51.100.7');
    expect(denied.statusCode).toBe(403);
    expect(denied.json().error.code).toBe('IP_NOT_ALLOWED');
    expect((await from('203.0.113.9')).statusCode).toBe(200);
    // Keys too, and the organization's own pages.
    expect((await from('198.51.100.7', key)).statusCode).toBe(403);
    expect(
      (await api(alice, 'GET', `/api/orgs/${org}`, undefined, { remoteAddress: '198.51.100.7' }))
        .statusCode
    ).toBe(403);
    // Manifests stay public unless the policy includes them.
    const manifest = (remoteAddress: string) =>
      app.inject({ method: 'GET', url: `/api/manifest/${ws}/portal/staging`, remoteAddress });
    expect((await manifest('198.51.100.7')).statusCode).toBe(200);
    expect(
      (
        await save({
          minRetentionDays: 30,
          ipAllowlist: ['203.0.113.0/24'],
          ipAllowlistManifests: true,
        })
      ).statusCode
    ).toBe(200);
    expect((await manifest('198.51.100.7')).statusCode).toBe(403);
    expect((await manifest('203.0.113.9')).statusCode).toBe(200);

    // Behind a trusted proxy (loopback by default), the client address is X-Forwarded-For.
    const viaProxy = await app.inject({
      method: 'GET',
      url: `/api/workspaces/${ws}`,
      headers: { ...bearer(owner), 'x-forwarded-for': '203.0.113.20' },
      remoteAddress: '127.0.0.1',
    });
    expect(viaProxy.statusCode).toBe(200);
    expect((await save({ minRetentionDays: 30 })).statusCode).toBe(200);
    expect((await from('198.51.100.7')).statusCode).toBe(200);
  });
});
