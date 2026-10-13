// Copyright The Harmoniq Authors
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'crypto';
import { FastifyInstance } from 'fastify';
import type { OrgEventName } from '@harmoniq/core/dist/schemas/OrgEventsSchema';
import { buildApp } from '../app';
import { ConsoleMailer } from '../adapters/mail/ConsoleMailer';
import { RecordingMailer } from '../services/emailLog';
import { sealSecret } from '../services/crypto';
import {
  NOTIFY_QUEUE,
  ORG_WEBHOOK_QUEUE,
  OrgEvents,
  describeOrgEvent,
  handleOrgWebhookDelivery,
} from '../services/orgEvents';
import { Quotas } from '../services/quotas';
import { Fixtures, bearer } from './helpers/fixtures';

// TAD-09/10: organization webhooks and notification channels.
describe('Organization webhooks and notifications (TAD-09, TAD-10)', () => {
  let app: FastifyInstance;
  let fx: Fixtures;
  const run = randomUUID().slice(0, 8);
  const org = `evt-${run}`;
  let orgId: string;
  let alice: string;
  const emitted: Array<{ event: OrgEventName; payload: Record<string, unknown> }> = [];

  type Method = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  const api = (as: string, method: Method, url: string, payload?: object) =>
    app.inject({ method, url, payload, headers: bearer(as) });
  const db = () => app.container.systemDb;
  const quiet = { info() {}, warn() {}, error() {}, debug() {} } as never;
  /** An OrgEvents whose queue and HTTP calls are recorded. */
  const recording = (fetchImpl?: typeof fetch) => {
    const sent: Array<{ queue: string; data: Record<string, unknown> }> = [];
    const events = new OrgEvents({
      systemDb: db(),
      boss: {
        send: async (queue: string, data: Record<string, unknown>) => {
          sent.push({ queue, data });
          return 'job';
        },
      } as never,
      logger: quiet,
      encryptionKey: app.config.encryptionKey,
      mailer: () => app.container.mailer,
      instanceName: () => 'Harmoniq',
      webOrigin: 'https://dash.example.test',
      fetchImpl: fetchImpl ?? (async () => new Response('ok')),
      checkUrl: async () => null,
    });
    return { events, sent };
  };

  beforeAll(async () => {
    app = await buildApp();
    await app.ready();
    fx = new Fixtures(app);
    alice = await fx.session(await fx.user());
    await api(alice, 'POST', '/api/orgs', { name: org, slug: org });
    orgId = (await db().organization.findUniqueOrThrow({ where: { slug: org } })).id;
    // Record what the routes emit (the test app has no job queue).
    const real = app.container.orgEvents.emit.bind(app.container.orgEvents);
    app.container.orgEvents.emit = async (id, event, payload) => {
      if (id === orgId) emitted.push({ event, payload });
      return real(id, event, payload);
    };
  });

  afterAll(async () => {
    await db().workspace.deleteMany({ where: { organization: { slug: org } } });
    await db().organization.deleteMany({ where: { slug: org } });
    await fx.cleanup();
    await app.close();
  });

  it('manages org webhooks; the secret is shown once; private URLs are refused', async () => {
    const W = `/api/orgs/${org}/webhooks`;
    expect(
      (await api(alice, 'POST', W, { url: 'http://169.254.169.254/hook', events: ['*'] }))
        .statusCode
    ).toBe(400);
    const created = await api(alice, 'POST', W, {
      url: 'https://8.8.8.8/hook',
      events: ['org.member.added', 'quota.exceeded'],
    });
    expect(created.statusCode).toBe(201);
    expect(created.json().secret).toMatch(/^whsec_/);
    const listed = (await api(alice, 'GET', W)).json().endpoints;
    expect(listed[0]).not.toHaveProperty('secret');
    const { id } = created.json();
    expect((await api(alice, 'PATCH', `${W}/${id}`, { paused: true })).json()).toMatchObject({
      paused: true,
    });

    const member = await fx.session(await fx.user());
    expect((await api(member, 'GET', W)).statusCode).toBe(404);
    expect((await api(alice, 'DELETE', `${W}/${id}`)).statusCode).toBe(204);
  });

  it('emits org events after successful changes only', async () => {
    emitted.length = 0;
    const bob = await fx.user();
    await api(alice, 'POST', `/api/orgs/${org}/members`, { email: bob.email });
    const memberId = (
      await db().organizationMember.findFirstOrThrow({
        where: { organization: { slug: org }, userId: bob.id },
      })
    ).id;
    expect(
      (await api(alice, 'PATCH', `/api/orgs/${org}/members/${memberId}`, { role: 'nope' }))
        .statusCode
    ).toBe(400);
    await api(alice, 'PATCH', `/api/orgs/${org}/members/${memberId}`, { role: 'org_auditor' });
    await api(alice, 'DELETE', `/api/orgs/${org}/members/${memberId}`);
    await api(alice, 'POST', `/api/orgs/${org}/workspaces`, { name: 'Ev', slug: `${org}-ws` });
    const key = (
      await api(alice, 'POST', `/api/orgs/${org}/keys`, { name: 'ci', scopes: ['deploy:write'] })
    ).json();
    await api(alice, 'DELETE', `/api/orgs/${org}/keys/${key.id}`);
    await api(alice, 'PUT', `/api/orgs/${org}/policy`, { minRetentionDays: 30 });

    expect(emitted.map((e) => e.event)).toEqual([
      'org.member.added',
      'org.member.role_changed',
      'org.member.removed',
      'org.workspace.created',
      'org.key.created',
      'org.key.revoked',
      'org.policy.updated',
    ]);
    expect(emitted[0].payload).toMatchObject({ email: bob.email, role: 'org_member' });
    expect(emitted[1].payload).toMatchObject({ email: bob.email, role: 'org_auditor' });
    expect(emitted[2].payload).toMatchObject({ email: bob.email });
    expect(emitted[3].payload).toMatchObject({ workspace: `${org}-ws` });
    expect(emitted[5].payload).toMatchObject({ name: 'ci' });
    expect(emitted[6].payload).toEqual({ fields: ['minRetentionDays'] });
  });

  it('queues deliveries for subscribed webhooks and channels only', async () => {
    const [all, members, quotas] = await Promise.all(
      [['*'], ['org.member.added'], ['quota.exceeded']].map((events) =>
        db().orgWebhookEndpoint.create({
          data: {
            organizationId: orgId,
            url: 'https://8.8.8.8/h',
            events,
            secret: sealSecret('s', app.config.encryptionKey),
          },
        })
      )
    );
    const channel = await db().notificationChannel.create({
      data: {
        organizationId: orgId,
        kind: 'email',
        name: 'Ops',
        target: 'ops@example.test',
        events: ['org.member.added'],
      },
    });
    const { events, sent } = recording();
    await events.emit(orgId, 'org.member.added', { email: 'x@example.test', role: 'org_member' });
    const hooks = sent
      .filter((s) => s.queue === ORG_WEBHOOK_QUEUE)
      .map((s) => s.data.webhookEndpointId);
    expect(hooks.sort()).toEqual([all.id, members.id].sort());
    expect(hooks).not.toContain(quotas.id);
    expect(sent.filter((s) => s.queue === NOTIFY_QUEUE).map((s) => s.data.channelId)).toEqual([
      channel.id,
    ]);
    expect(sent[0].data.payload).toMatchObject({
      event: 'org.member.added',
      organization: org,
      email: 'x@example.test',
    });
    await db().orgWebhookEndpoint.deleteMany({ where: { organizationId: orgId } });
    await db().notificationChannel.deleteMany({ where: { organizationId: orgId } });
  });

  it('delivers org webhooks with signatures, retries and dead letters', async () => {
    const endpoint = await db().orgWebhookEndpoint.create({
      data: {
        organizationId: orgId,
        url: 'https://8.8.8.8/h',
        events: ['*'],
        secret: sealSecret('topsecret', app.config.encryptionKey),
        maxRetries: 1,
      },
    });
    const job = (attempt: number) => ({
      data: {
        workspaceId: orgId,
        webhookEndpointId: endpoint.id,
        event: 'org.key.created',
        payload: { event: 'org.key.created', name: 'ci' },
        attempt,
        firstAttemptAt: new Date().toISOString(),
      },
    });
    const requests: Array<{ headers: Record<string, string>; body: string }> = [];
    const ok = (async (_url: string, init: RequestInit) => {
      requests.push({ headers: init.headers as Record<string, string>, body: String(init.body) });
      return new Response('ok');
    }) as unknown as typeof fetch;
    const retries: string[] = [];
    const boss = { send: async (queue: string) => (retries.push(queue), 'job') } as never;
    const opts = { encryptionKey: app.config.encryptionKey, fetchImpl: ok };

    await handleOrgWebhookDelivery(job(0), db(), quiet, boss, opts);
    expect(requests[0].headers['X-Harmoniq-Event']).toBe('org.key.created');
    const { createHmac } = await import('crypto');
    expect(requests[0].headers['X-Harmoniq-Signature']).toBe(
      createHmac('sha256', 'topsecret').update(requests[0].body).digest('hex')
    );
    expect(
      await db().orgWebhookDelivery.count({ where: { endpointId: endpoint.id, success: true } })
    ).toBe(1);

    const failing = (async () => new Response('no', { status: 500 })) as unknown as typeof fetch;
    await handleOrgWebhookDelivery(job(0), db(), quiet, boss, { ...opts, fetchImpl: failing });
    expect(retries).toEqual([ORG_WEBHOOK_QUEUE]);
    await handleOrgWebhookDelivery(job(1), db(), quiet, boss, { ...opts, fetchImpl: failing });
    expect(
      await db().orgWebhookDeadLetter.findFirst({ where: { endpointId: endpoint.id } })
    ).toMatchObject({ organizationId: orgId, finalStatusCode: 500, totalAttempts: 1 });
    expect(
      (await api(alice, 'GET', `/api/orgs/${org}/webhooks-dead-letters`)).json().deadLetters
    ).toHaveLength(1);
  });

  it('notifies by email, Slack and Teams, and records failures', async () => {
    const posted: Array<{ url: string; body: string }> = [];
    let fail = false;
    const fetchImpl = (async (url: string, init: RequestInit) => {
      posted.push({ url, body: String(init.body) });
      return new Response('ok', { status: fail ? 500 : 200 });
    }) as unknown as typeof fetch;
    const { events } = recording(fetchImpl);
    const email = await db().notificationChannel.create({
      data: {
        organizationId: orgId,
        kind: 'email',
        name: 'Ops',
        target: 'ops@example.test',
        events: ['*'],
      },
    });
    const slack = await db().notificationChannel.create({
      data: {
        organizationId: orgId,
        kind: 'slack',
        name: 'Slack',
        target: sealSecret('https://hooks.slack.test/T/1', app.config.encryptionKey),
        events: ['*'],
      },
    });
    const body = {
      event: 'quota.warning',
      organization: org,
      workspace: 'shop',
      quota: 'members',
      used: 4,
      limit: 5,
    };
    await events.notify({ channelId: email.id, event: 'quota.warning', body });
    const mail = ((app.container.mailer as RecordingMailer).inner as ConsoleMailer).sent.at(-1)!;
    expect(mail).toMatchObject({ to: 'ops@example.test' });
    expect(mail.subject).toContain('shop (' + org + ') is at 80% of its members quota (4 of 5)');
    expect(mail.text).toContain(`https://dash.example.test/orgs/${org}`);

    await events.notify({ channelId: slack.id, event: 'quota.warning', body });
    expect(posted[0].url).toBe('https://hooks.slack.test/T/1');
    expect(JSON.parse(posted[0].body).text).toContain('is at 80% of its members quota');
    fail = true;
    await expect(
      events.notify({ channelId: slack.id, event: 'quota.warning', body })
    ).rejects.toThrow();
    expect(
      (await db().notificationChannel.findUniqueOrThrow({ where: { id: slack.id } })).lastError
    ).toBe('HTTP 500');

    // The API never returns an incoming-webhook URL.
    const listed = (await api(alice, 'GET', `/api/orgs/${org}/notifications`)).json().channels;
    expect(listed.find((c: { id: string }) => c.id === slack.id).target).toBeNull();
    expect(listed.find((c: { id: string }) => c.id === email.id).target).toBe('ops@example.test');
  });

  it('describes every event in a sentence', () => {
    const body = {
      organization: 'acme',
      email: 'a@b.c',
      role: 'org_admin',
      workspace: 'shop',
      name: 'ci',
      quota: 'members',
      used: 1,
      limit: 2,
      from: 'hobby',
      to: 'startup',
      type: 'deploy',
      environment: 'production',
      domain: 'acme.com',
      fields: ['lockSso'],
    };
    for (const event of [
      'org.member.added',
      'org.member.removed',
      'org.member.role_changed',
      'org.workspace.created',
      'org.workspace.deleted',
      'org.workspace.restored',
      'org.workspace.attached',
      'org.workspace.detached',
      'org.key.created',
      'org.key.revoked',
      'org.key.rotated',
      'org.policy.updated',
      'quota.warning',
      'quota.exceeded',
      'plan.changed',
      'deploy.approval_requested',
      'domain.verification_lost',
    ] as OrgEventName[]) {
      expect(describeOrgEvent(event, body), event).toMatch(/\w/);
    }
    expect(describeOrgEvent('org.key.rotated', body)).toBe('API key "ci" was rotated in acme');
  });

  it("sends a workspace's quota events to its organization", async () => {
    const { workspace } = await fx.workspace();
    await db().workspace.update({ where: { id: workspace.id }, data: { organizationId: orgId } });
    const heard: Array<{ event: string; payload: Record<string, unknown> }> = [];
    const quotas = new Quotas({
      systemDb: db(),
      plans: {
        forWorkspace: async () => ({ plan: 'hobby', features: {}, limits: { modules: 1 } }),
      } as never,
      webhooks: app.container.webhooks,
      logger: quiet,
      orgEvents: { emit: async (_id, event, payload) => void heard.push({ event, payload }) },
    });
    await expect(quotas.require({ workspaceId: workspace.id }, 'modules')).rejects.toMatchObject({
      code: 'QUOTA_EXCEEDED',
    });
    expect(heard).toEqual([
      {
        event: 'quota.exceeded',
        payload: expect.objectContaining({ workspace: workspace.slug, quota: 'modules' }),
      },
    ]);
  });
});
