// Copyright The Harmoniq Authors
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomBytes, randomUUID } from 'crypto';
import { FastifyInstance } from 'fastify';
import { buildApp } from '../app';
import { ConsoleMailer } from '../adapters/mail/ConsoleMailer';
import { RecordingMailer } from '../services/emailLog';
import { Fixtures, bearer } from './helpers/fixtures';

// INST-39: sign-in attempts and the security page; INST-36: one actor across all logs.
describe('Security page and audit search (INST-36, INST-39)', () => {
  let app: FastifyInstance;
  let fx: Fixtures;
  let root: string;
  const run = randomUUID().slice(0, 8);
  const email = `sec-${run}@example.com`;
  const db = () => app.container.systemDb;
  const admin = (url: string) => app.inject({ url, headers: bearer(root) });

  beforeAll(async () => {
    app = await buildApp();
    await app.ready();
    fx = new Fixtures(app);
    root = await fx.session(await fx.user({ instanceAdmin: true }));
  });

  afterAll(async () => {
    await db().signInEvent.deleteMany({ where: { email } });
    await db().emailLoginToken.deleteMany({ where: { email } });
    await db().user.deleteMany({ where: { email } });
    await db().organization.deleteMany({ where: { slug: `sec-${run}` } });
    await fx.cleanup();
    await app.close();
  });

  it('records sign-ins, failed ones with their reason and address', async () => {
    const nonce = randomBytes(16).toString('base64url');
    await app.inject({
      method: 'POST',
      url: '/api/auth/email/request',
      payload: { email, nonce, redirectUri: `${app.config.webOrigin}/auth/verify` },
    });
    const mailer = (app.container.mailer as RecordingMailer).inner as ConsoleMailer;
    const code = [...mailer.sent]
      .reverse()
      .find((m) => m.to === email)!
      .text.match(/code: (\d{6})/)![1];
    const wrong = code === '000000' ? '111111' : '000000';
    const verify = (c: string) =>
      app.inject({
        method: 'POST',
        url: '/api/auth/email/verify',
        payload: { email, code: c },
        remoteAddress: '203.0.113.7',
      });
    expect((await verify(wrong)).statusCode).toBe(401);
    expect((await verify(wrong)).statusCode).toBe(401);
    const ok = await verify(code);
    expect(ok.statusCode).toBe(200);
    await new Promise((r) => setTimeout(r, 100)); // written after the response

    const events = await db().signInEvent.findMany({
      where: { email },
      orderBy: { createdAt: 'asc' },
    });
    expect(events.map((e) => [e.method, e.success, e.ip])).toEqual([
      ['email', false, '203.0.113.7'],
      ['email', false, '203.0.113.7'],
      ['email', true, '203.0.113.7'],
    ]);
    expect(events[0].reason).toBeTruthy();
    expect(events[2].userId).toBe(ok.json().user.id);
  });

  it('shows failures by address and email, rejected keys, rate limits and SCIM errors', async () => {
    const { workspace } = await fx.workspace();
    // Revoked and expired keys still in use.
    const revoked = await fx.apiKey(workspace.id, { revokedAt: new Date() });
    const expired = await fx.apiKey(workspace.id, { expiresAt: new Date(Date.now() - 1000) });
    for (const k of [revoked, expired]) {
      const res = await app.inject({
        url: `/api/workspaces/${workspace.slug}`,
        headers: bearer(k.raw),
      });
      expect(res.statusCode).toBe(401);
    }
    await new Promise((r) => setTimeout(r, 100)); // written after the response
    // Rate-limited requests are counted per workspace.
    app.container.usage.rateLimited(workspace.slug);
    app.container.usage.rateLimited(workspace.slug);
    await app.container.usage.flush();
    // A SCIM request that failed.
    const org = await db().organization.create({ data: { slug: `sec-${run}`, name: 'Sec' } });
    await db().scimAuditEvent.create({
      data: {
        organizationId: org.id,
        operation: 'createUser',
        scimUserId: 'x',
        payload: {},
        statusCode: 409,
      },
    });

    const page = (await admin('/api/admin/security?days=1')).json();
    expect(page.failedByIp).toContainEqual(
      expect.objectContaining({ ip: '203.0.113.7', failures: 2 })
    );
    expect(page.failedByEmail).toContainEqual(expect.objectContaining({ email, failures: 2 }));
    expect(page.signIns.failed).toBeGreaterThanOrEqual(2);
    const reasons = page.rejectedKeys.map((k: { reason: string }) => k.reason);
    expect(reasons).toEqual(expect.arrayContaining(['revoked', 'expired']));
    expect(page.rateLimitedWorkspaces).toContainEqual({ workspace: workspace.slug, requests: 2 });
    expect(page.scimErrors).toContainEqual(
      expect.objectContaining({
        tenant: { type: 'organization', slug: `sec-${run}` },
        statusCode: 409,
      })
    );
  });

  it('finds one actor in every log, and records the search (INST-36)', async () => {
    const user = await fx.user();
    const { workspace } = await fx.workspace();
    const org = await db().organization.findUniqueOrThrow({ where: { slug: `sec-${run}` } });
    const base = {
      actorType: 'user' as const,
      actorId: user.id,
      resourceType: 'x',
      resourceId: 'y',
    };
    await db().auditEvent.create({ data: { ...base, workspaceId: workspace.id, action: 'a.ws' } });
    await db().organizationAuditEvent.create({
      data: { ...base, organizationId: org.id, action: 'a.org' },
    });
    await db().instanceAuditEvent.create({ data: { ...base, action: 'a.instance' } });

    expect((await admin('/api/admin/audit/search')).statusCode).toBe(400);
    const found = (await admin(`/api/admin/audit/search?actor=${user.email}`)).json().events;
    expect(found.map((e: { scope: string; tenant: string | null }) => [e.scope, e.tenant])).toEqual(
      expect.arrayContaining([
        ['workspace', workspace.slug],
        ['organization', `sec-${run}`],
        ['instance', null],
      ])
    );
    expect(found[0].actor).toMatchObject({ label: user.email });
    expect(
      await db().instanceAuditEvent.findFirst({
        where: { action: 'instance.audit_search', resourceId: user.email },
      })
    ).toMatchObject({ metadata: { results: 3 } });

    // The instance log filters by resource type too.
    const filtered = (
      await admin('/api/admin/audit?resourceType=actor&action=instance.audit')
    ).json();
    expect(filtered.events.every((e: { resourceType: string }) => e.resourceType === 'actor')).toBe(
      true
    );
  });
});
