// Copyright The Harmoniq Authors
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { FastifyInstance } from 'fastify';
import { PgBoss } from 'pg-boss';
import { buildApp } from '../app';
import { REPLICA_ID, migrationStatus, purgeOperationalLogs } from '../services/operations';
import { Fixtures, bearer } from './helpers/fixtures';

// INST-22, INST-28, INST-37, INST-38: operations of the instance.
describe('Instance operations (INST-22, 28, 37, 38)', () => {
  let app: FastifyInstance;
  let fx: Fixtures;
  let root: string;
  const db = () => app.container.systemDb;
  type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  const api = (method: Method, url: string, payload?: object, token = root) =>
    app.inject({ method, url, payload, headers: bearer(token) });
  const minutes = (n: number) => new Date(Date.now() + n * 60_000).toISOString();

  beforeAll(async () => {
    app = await buildApp();
    await app.ready();
    fx = new Fixtures(app);
    root = await fx.session(await fx.user({ instanceAdmin: true }));
  });

  afterAll(async () => {
    for (const key of ['announcement', 'maintenance', 'emailTemplates']) {
      await api('DELETE', `/api/admin/settings/${key}`);
    }
    await fx.cleanup();
    await app.close();
  });

  it('shows the build, migrations and every replica (INST-28)', async () => {
    const other = await buildApp();
    await other.ready();
    // Heartbeats are written at start.
    await new Promise((r) => setTimeout(r, 200));
    const res = await api('GET', '/api/admin/system');
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.replica).toBe(REPLICA_ID);
    expect(body.build).toMatchObject({ node: process.version });
    expect(body.migrations.pending).toEqual([]);
    expect(body.migrations.latest).toMatch(/admin_operations$/);
    const self = body.replicas.find((r: { self: boolean }) => r.self);
    expect(self).toMatchObject({ live: true });
    expect(self.configAgeSeconds).toBeGreaterThanOrEqual(0);
    await other.close();

    // A build with a migration the database lacks reports it.
    const status = await migrationStatus(db(), [body.migrations.latest, '29990101000000_future']);
    expect(status.pending).toEqual(['29990101000000_future']);
  });

  it('lists failed jobs, retries them and runs maintenance jobs only (INST-28)', async () => {
    const boss = new PgBoss({
      connectionString: process.env.SYSTEM_DATABASE_URL!,
      schedule: false,
      supervise: false,
    });
    await boss.start();
    const queue = `test.ops-${Date.now()}`;
    try {
      await boss.createQueue(queue);
      await boss.createQueue('gc.softDelete');
      await boss.send(queue, { n: 1 }, { retryLimit: 0 });
      const [job] = await boss.fetch(queue);
      await boss.fail(queue, job.id, { message: 'disk full' });

      // Without a running queue on this registry, retry and run are refused.
      expect((await api('POST', `/api/admin/jobs/${job.id}/retry`)).statusCode).toBe(409);
      app.container.boss = boss;

      const queues = (await api('GET', '/api/admin/jobs')).json().queues;
      expect(queues.find((q: { name: string }) => q.name === queue)).toMatchObject({
        failed: 1,
        runnable: false,
      });
      const failed = (await api('GET', `/api/admin/jobs/failed?queue=${queue}`)).json().jobs;
      expect(failed).toEqual([expect.objectContaining({ id: job.id, error: 'disk full' })]);

      expect((await api('POST', `/api/admin/jobs/${job.id}/retry`)).statusCode).toBe(200);
      expect((await api('GET', `/api/admin/jobs/failed?queue=${queue}`)).json().jobs).toEqual([]);
      expect((await api('POST', '/api/admin/jobs/not-a-job/retry')).statusCode).toBe(404);

      expect((await api('POST', `/api/admin/jobs/${queue}/run`)).statusCode).toBe(400);
      const run = await api('POST', '/api/admin/jobs/gc.softDelete/run');
      expect(run.statusCode).toBe(202);
      expect(
        await db().instanceAuditEvent.findFirst({
          where: { action: 'instance.job_run', resourceId: 'gc.softDelete' },
        })
      ).not.toBeNull();
    } finally {
      app.container.boss = null;
      await boss.deleteQueue(queue).catch(() => undefined);
      await boss.deleteAllJobs('gc.softDelete').catch(() => undefined);
      await boss.stop({ graceful: false });
    }
  });

  it('shows an announcement only between its start and end (INST-22)', async () => {
    const shown = async () => (await app.inject('/api/instance')).json().announcement;
    await api('PUT', '/api/admin/settings/announcement', {
      message: 'Upgrade on Sunday',
      level: 'warning',
      startsAt: minutes(5),
    });
    expect(await shown()).toBeNull();
    await api('PUT', '/api/admin/settings/announcement', {
      message: 'Upgrade on Sunday',
      level: 'warning',
      startsAt: minutes(-5),
      endsAt: minutes(60),
    });
    expect(await shown()).toMatchObject({ message: 'Upgrade on Sunday', level: 'warning' });
    expect(
      (
        await api('PUT', '/api/admin/settings/announcement', {
          message: 'x',
          startsAt: minutes(5),
          endsAt: minutes(1),
        })
      ).statusCode
    ).toBe(400);
  });

  it('makes the instance read-only during maintenance (INST-37)', async () => {
    const owner = await fx.user();
    const token = await fx.session(owner);
    const { workspace } = await fx.workspace();
    await fx.member(workspace.id, owner.id, 'owner');
    const rename = () =>
      api('PATCH', `/api/workspaces/${workspace.slug}`, { name: 'Renamed' }, token);

    // Scheduled: announced, not active yet.
    await api('PUT', '/api/admin/settings/maintenance', {
      from: minutes(30),
      until: minutes(90),
      message: 'Database upgrade',
    });
    expect((await app.inject('/api/instance')).json().maintenance).toMatchObject({
      active: false,
      message: 'Database upgrade',
    });
    expect((await rename()).statusCode).not.toBe(503);

    await api('PUT', '/api/admin/settings/maintenance', {
      until: minutes(10),
      message: 'Database upgrade',
    });
    const refused = await rename();
    expect(refused.statusCode).toBe(503);
    expect(refused.json().error.code).toBe('MAINTENANCE');
    expect(Number(refused.headers['retry-after'])).toBeGreaterThan(500);
    // Reads, manifests and the admin API still work.
    expect(
      (await api('GET', `/api/workspaces/${workspace.slug}`, undefined, token)).statusCode
    ).toBe(200);
    expect((await app.inject(`/api/manifest/${workspace.slug}/portal/production`)).statusCode).toBe(
      200
    );
    expect((await api('DELETE', '/api/admin/settings/maintenance')).statusCode).toBe(204);
    expect((await rename()).statusCode).toBe(200);
  });

  it('logs every email without its body and applies template overrides (INST-38)', async () => {
    await api('PUT', '/api/admin/settings/emailTemplates', {
      test: { subject: 'Custom subject', intro: 'Hello from ops.' },
    });
    const sent = await api('POST', '/api/admin/settings/email/test');
    expect(sent.statusCode).toBe(200);
    const to = sent.json().sentTo as string;
    const logged = await db().emailDelivery.findFirst({
      where: { to },
      orderBy: { createdAt: 'desc' },
    });
    expect(logged).toMatchObject({ template: 'test', status: 'sent', error: null });
    const inner = (app.container.mailer as unknown as { inner: { sent: Array<{ to: string }> } })
      .inner.sent;
    expect(inner.filter((m) => m.to === to).at(-1)).toMatchObject({
      subject: 'Custom subject',
      text: expect.stringMatching(/^Hello from ops\.\n\n/),
    });

    // Retention: 30 days for emails, 90 for sign-in events.
    await db().emailDelivery.create({
      data: {
        to,
        template: 'test',
        status: 'sent',
        createdAt: new Date(Date.now() - 31 * 86_400_000),
      },
    });
    const purged = await purgeOperationalLogs(db());
    expect(purged.emails).toBeGreaterThanOrEqual(1);
    expect(await db().emailDelivery.count({ where: { to } })).toBe(1);
    await db().emailDelivery.deleteMany({ where: { to } });
  });
});
