// Copyright The Harmoniq Authors
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { FastifyInstance } from 'fastify';
import { buildApp } from '../app';
import { expireRequests } from '../services/approvals';
import { Fixtures, bearer } from './helpers/fixtures';

describe('Change approvals (M4.3, APR-01..18)', () => {
  let app: FastifyInstance;
  let fx: Fixtures;
  let ws: string;
  let workspaceId: string;
  let owner: string;
  let adminA: string;
  let adminB: string;
  let dev: string;
  let ownerId: string;
  let adminAId: string;
  let key: string;

  const api = (
    as: string,
    method: 'GET' | 'POST' | 'PUT' | 'DELETE',
    url: string,
    payload?: object,
    headers: Record<string, string> = {}
  ) => app.inject({ method, url, payload, headers: { ...bearer(as), ...headers } });
  const policyUrl = (env = 'production') =>
    `/api/workspaces/${ws}/host-apps/portal/environments/${env}/approval-policy`;
  const deploy = (as: string, version: string, env = 'production', headers = {}) =>
    api(
      as,
      'POST',
      `/api/workspaces/${ws}/modules/checkout/deploy`,
      {
        environment: env,
        url: `https://cdn.example.com/checkout/${version}.js`,
        version,
        integrity: 'sha384-abc',
      },
      headers
    );
  const decide = (as: string, id: string, action: 'approve' | 'reject', comment?: string) =>
    api(as, 'POST', `/api/workspaces/${ws}/approvals/${id}/${action}`, comment ? { comment } : {});
  const active = async () =>
    (await app.inject({ method: 'GET', url: `/api/manifest/${ws}/portal/production` })).json()
      .modules[0]?.version;

  beforeAll(async () => {
    app = await buildApp();
    await app.ready();
    fx = new Fixtures(app);
    const { workspace } = await fx.workspace();
    ws = workspace.slug;
    workspaceId = workspace.id;
    const users = await Promise.all([fx.user(), fx.user(), fx.user(), fx.user()]);
    await fx.member(workspace.id, users[0].id, 'owner');
    await fx.member(workspace.id, users[1].id, 'admin');
    await fx.member(workspace.id, users[2].id, 'admin');
    await fx.member(workspace.id, users[3].id, 'developer');
    [owner, adminA, adminB, dev] = await Promise.all(users.map((u) => fx.session(u)));
    ownerId = users[0].id;
    adminAId = users[1].id;
    key = (await fx.apiKey(workspace.id, { scopes: ['deploy:write'] })).raw;
    // Staging has no policy (APR-03); production gets one.
    expect((await deploy(key, '1.0.0', 'staging')).statusCode).toBe(201);
    expect((await deploy(key, '1.0.0')).statusCode).toBe(201);
  });

  afterAll(async () => {
    await fx.cleanup();
    await app.close();
  });

  it('lets admins set per-environment policies (APR-01/03/13)', async () => {
    expect(
      (await api(dev, 'PUT', policyUrl(), { requiredApprovers: 2, eligibleRoles: ['admin'] }))
        .statusCode
    ).toBe(403);
    const bad = await api(adminA, 'PUT', policyUrl(), {
      eligibleRoles: ['admin'],
      ticketUrlPattern: 'https://jira.example.com/browse/',
    });
    expect(bad.statusCode).toBe(400);
    const res = await api(adminA, 'PUT', policyUrl(), {
      requiredApprovers: 2,
      eligibleRoles: ['admin', 'owner'],
      requireChangeTicket: true,
      ticketUrlPattern: 'https://jira.example.com/browse/{id}',
    });
    expect(res.statusCode).toBe(200);
    const list = (await api(dev, 'GET', `/api/workspaces/${ws}/approval-policies`)).json();
    expect(list.policies).toEqual([
      expect.objectContaining({ environment: 'production', requiredApprovers: 2 }),
    ]);
  });

  it('turns a change into a pending request, needing a change ticket (APR-04/13/14/17)', async () => {
    expect((await deploy(key, '2.0.0', 'staging')).statusCode).toBe(201);
    expect((await deploy(key, '2.0.0')).statusCode).toBe(400); // no ticket

    const dispatch = vi.spyOn(app.container.webhooks, 'dispatch');
    const res = await deploy(key, '2.0.0', 'production', { 'x-harmoniq-change-ticket': 'OPS-42' });
    expect(res.statusCode).toBe(202);
    expect(res.json()).toMatchObject({
      status: 'pending_approval',
      requiredApprovers: 2,
      changeTicket: { id: 'OPS-42', url: 'https://jira.example.com/browse/OPS-42' },
    });
    expect(await active()).toBe('1.0.0');
    expect(dispatch.mock.calls.some((c) => c[1] === 'deploy.approval_requested')).toBe(true);
    dispatch.mockRestore();
  });

  it('needs eligible approvers other than the requester, then executes once (APR-05..07, 15)', async () => {
    const [req] = (
      await api(adminA, 'GET', `/api/workspaces/${ws}/approvals?status=pending_approval`)
    ).json().requests;
    expect(req).toMatchObject({
      type: 'deploy',
      module: 'checkout',
      environment: 'production',
      canDecide: true,
    });
    expect((await decide(dev, req.id, 'approve')).statusCode).toBe(403); // role not eligible
    expect((await decide(key, req.id, 'approve')).statusCode).toBe(403); // API keys never approve

    const first = await decide(adminA, req.id, 'approve', 'LGTM');
    expect(first.json()).toMatchObject({
      status: 'pending_approval',
      approvals: [{ decision: 'approved' }],
    });
    expect((await decide(adminA, req.id, 'approve')).statusCode).toBe(403); // already decided
    expect(await active()).toBe('1.0.0');

    const second = await decide(owner, req.id, 'approve');
    expect(second.json()).toMatchObject({ status: 'executed', result: { statusCode: 201 } });
    expect(await active()).toBe('2.0.0');
    expect((await decide(adminB, req.id, 'approve')).statusCode).toBe(409);

    // APR-18: the version and its audit event carry the approval chain.
    const versions = (
      await api(
        dev,
        'GET',
        `/api/workspaces/${ws}/modules/checkout/versions?environment=production`
      )
    ).json().versions;
    expect(versions[0].approval).toMatchObject({
      requestId: req.id,
      changeTicket: { id: 'OPS-42' },
      decisions: [
        { approverId: adminAId, decision: 'approved', comment: 'LGTM' },
        { approverId: ownerId, decision: 'approved' },
      ],
    });
    const deployAudit = await app.container.systemDb.auditEvent.findFirst({
      where: { workspaceId, action: 'module.deploy', resourceId: versions[0].id },
    });
    expect(deployAudit?.metadata).toMatchObject({ approval: { requestId: req.id } });
  });

  it('forbids self-approval (APR-05) and ends on one rejection (APR-08)', async () => {
    const created = await deploy(adminA, '3.0.0', 'production', {
      'x-harmoniq-change-ticket': 'OPS-43',
    });
    const id = created.json().requestId;
    const self = await decide(adminA, id, 'approve');
    expect(self.statusCode).toBe(403);
    expect(self.json().error.message).toMatch(/own request/);
    expect((await decide(adminB, id, 'reject', 'Not during the sale')).json().status).toBe(
      'rejected'
    );
    expect((await decide(owner, id, 'approve')).statusCode).toBe(409);
    expect(await active()).toBe('2.0.0');
  });

  it('lets owners bypass with a justification, flagged (APR-10..12)', async () => {
    const id = (
      await deploy(key, '4.0.0', 'production', { 'x-harmoniq-change-ticket': 'INC-9' })
    ).json().requestId;
    const bypass = (as: string, bypassJustification: string) =>
      api(as, 'POST', `/api/workspaces/${ws}/approvals/${id}/bypass`, { bypassJustification });
    expect((await bypass(adminB, 'Production is down, payment provider changed')).statusCode).toBe(
      403
    );
    expect((await bypass(owner, 'too short')).statusCode).toBe(400);
    const res = await bypass(owner, 'Production is down, payment provider changed');
    expect(res.json()).toMatchObject({ status: 'executed', bypassed: true });
    expect(await active()).toBe('4.0.0');
    const audit = await app.container.systemDb.auditEvent.findFirst({
      where: { workspaceId, action: 'deploy.emergency_bypass' },
    });
    expect(audit?.metadata).toMatchObject({ requestId: id });
    const versions = (
      await api(
        dev,
        'GET',
        `/api/workspaces/${ws}/modules/checkout/versions?environment=production`
      )
    ).json().versions;
    expect(versions[0].approval).toMatchObject({ bypassed: true });
  });

  it('expires requests nobody decided on (APR-09) and applies to other operations', async () => {
    const id = (
      await api(
        key,
        'POST',
        `/api/workspaces/${ws}/modules/checkout/rollback`,
        { environment: 'production', previous: true },
        { 'x-harmoniq-change-ticket': 'OPS-44' }
      )
    ).json().requestId;
    expect(id).toBeTruthy();
    await app.container.systemDb.deploymentRequest.update({
      where: { id },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    expect(await expireRequests(app)).toBeGreaterThanOrEqual(1);
    expect((await decide(owner, id, 'approve')).statusCode).toBe(409);
    expect(await active()).toBe('4.0.0');

    // Dry runs and the kill switch don't need approval.
    const dry = await api(key, 'POST', `/api/workspaces/${ws}/modules/checkout/deploy`, {
      environment: 'production',
      url: 'https://cdn.example.com/checkout/5.0.0.js',
      version: '5.0.0',
      integrity: 'sha384-abc',
      dryRun: true,
    });
    expect(dry.statusCode).toBe(200);
    const kill = await api(key, 'PUT', `/api/workspaces/${ws}/modules/checkout/kill-switch`, {
      environment: 'production',
      disabled: true,
      reason: 'emergency',
    });
    expect(kill.statusCode).toBe(200);
  });

  it('stops requiring approval once the policy is removed', async () => {
    expect((await api(adminA, 'DELETE', policyUrl())).statusCode).toBe(204);
    expect((await deploy(key, '6.0.0')).statusCode).toBe(201);
  });
});
