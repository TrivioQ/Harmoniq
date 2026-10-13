// Copyright The Harmoniq Authors
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'crypto';
import { FastifyInstance } from 'fastify';
import { PgBoss } from 'pg-boss';
import selfsigned from 'selfsigned';
import { buildApp } from '../app';
import { certificateExpiry, verifyTenantStorage } from '../services/overview';
import { encryptJson } from '../services/crypto';
import { Fixtures, bearer } from './helpers/fixtures';

// INST-27: the admin home's trends and "needs attention" list, one fixture per kind.
describe('Admin overview (INST-27)', () => {
  let app: FastifyInstance;
  let fx: Fixtures;
  let root: string;
  const run = randomUUID().slice(0, 8);
  const db = () => app.container.systemDb;
  const day = 86_400_000;

  beforeAll(async () => {
    app = await buildApp();
    await app.ready();
    fx = new Fixtures(app);
    root = await fx.session(await fx.user({ instanceAdmin: true }));
  });

  afterAll(async () => {
    await db().organization.deleteMany({ where: { slug: `ovw-${run}` } });
    await fx.cleanup();
    await app.close();
  });

  it('lists each kind of problem with its tenant, and the trends', async () => {
    const { workspace, hostApp } = await fx.workspace();
    const env = hostApp.Environments.find((e) => e.slug === 'production')!;
    const org = await db().organization.create({ data: { slug: `ovw-${run}`, name: 'Ovw' } });

    // 1. A manifest publish that failed.
    await db().environment.update({
      where: { id: env.id },
      data: { lastPublishError: 'AccessDenied', lastPublishedAt: new Date() },
    });
    // 2. A webhook dead letter.
    const endpoint = await db().webhookEndpoint.create({
      data: { workspaceId: workspace.id, url: 'https://8.8.8.8/h', events: ['*'], secret: 's' },
    });
    await db().webhookDeadLetter.create({
      data: {
        workspaceId: workspace.id,
        webhookEndpointId: endpoint.id,
        event: 'deploy.success',
        payload: {},
        totalAttempts: 5,
        firstAttemptAt: new Date(),
        exhaustedAt: new Date(),
      },
    });
    // 3. A failed job.
    const boss = new PgBoss({
      connectionString: process.env.SYSTEM_DATABASE_URL!,
      schedule: false,
      supervise: false,
    });
    await boss.start();
    const queue = `test.ovw-${run}`;
    await boss.createQueue(queue);
    await boss.send(queue, {}, { retryLimit: 0 });
    const [job] = await boss.fetch(queue);
    await boss.fail(queue, job.id, { message: 'boom' });
    // 4. A tenant bucket that fails verification (no such bucket here).
    await db().workspaceStorageConfig.create({
      data: {
        workspaceId: workspace.id,
        provider: 's3',
        bucket: `missing-${run}`,
        region: 'us-east-1',
        endpoint: 'http://127.0.0.1:1',
        credentialsEncrypted: {
          ...encryptJson({ accessKeyId: 'x', secretAccessKey: 'y' }, app.config.encryptionKey),
        },
      },
    });
    const verified = await verifyTenantStorage(db(), app.config.encryptionKey);
    expect(verified.failed).toBeGreaterThanOrEqual(1);
    // 5. A SAML signing certificate that expires in 10 days.
    const pems = await selfsigned.generate([{ name: 'commonName', value: 'idp' }], {
      notAfterDate: new Date(Date.now() + 10 * day),
      keySize: 2048,
      algorithm: 'sha256',
    });
    expect(certificateExpiry(pems.cert)!.getTime()).toBeGreaterThan(Date.now());
    await db().organization.update({
      where: { id: org.id },
      data: { samlConfig: { idpCert: pems.cert, idpSsoUrl: 'https://idp.test/sso' } },
    });
    // 6. An alert rule in error.
    await db().alertRule.create({
      data: {
        workspaceId: workspace.id,
        name: `rule-${run}`,
        condition: 'error_rate',
        threshold: 0.1,
        action: 'notify',
        actionConfig: {},
        lastError: 'Slack returned 404',
      },
    });
    // 7. A quota breach this week.
    await db().organizationAuditEvent.create({
      data: {
        organizationId: org.id,
        actorType: 'system',
        actorId: 'quota',
        action: 'quota.exceeded',
        resourceType: 'quota',
        resourceId: 'modules',
      },
    });
    // 8. A domain failing re-verification.
    await db().verifiedDomain.create({
      data: {
        domain: `ovw-${run}.test`,
        organizationId: org.id,
        token: 't',
        createdBy: 'test',
        verifiedAt: new Date(),
        failingSince: new Date(),
      },
    });
    // Trends: today's deploys.
    const today = new Date(new Date().toISOString().slice(0, 10));
    await db().usageDaily.create({ data: { workspaceId: workspace.id, day: today, deploys: 4 } });

    try {
      const res = await app.inject({ url: '/api/admin/overview', headers: bearer(root) });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      const mine = body.attention.filter(
        (i: { tenant: { slug: string } | null; subject: string }) =>
          i.tenant?.slug === workspace.slug || i.tenant?.slug === org.slug || i.subject === queue
      );
      const kinds = new Set(mine.map((i: { kind: string }) => i.kind));
      expect([...kinds].sort()).toEqual(
        [
          'alert_rule_error',
          'domain_failing',
          'failed_jobs',
          'publish_failed',
          'quota_exceeded',
          'saml_certificate_expiring',
          'storage_unverified',
          'webhook_dead_letters',
        ].sort()
      );
      expect(mine.find((i: { kind: string }) => i.kind === 'publish_failed')).toMatchObject({
        subject: 'portal/production',
        detail: 'AccessDenied',
      });
      expect(body.trends).toHaveLength(30);
      expect(body.trends.at(-1).deploys).toBeGreaterThanOrEqual(4);
      expect(body.counts.workspaces).toBeGreaterThan(0);
    } finally {
      await boss.deleteQueue(queue).catch(() => undefined);
      await boss.stop({ graceful: false });
    }
  });
});
