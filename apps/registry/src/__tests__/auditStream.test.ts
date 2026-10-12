// Copyright The Harmoniq Authors
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createHmac, randomUUID } from 'crypto';
import { FastifyInstance } from 'fastify';
import { buildApp } from '../app';
import { sealSecret } from '../services/crypto';
import {
  MAX_FAILURES,
  type StreamDeps,
  resendDeadLetter,
  streamSink,
} from '../services/auditStream';
import { Fixtures, bearer } from './helpers/fixtures';

// AUD-06: audit events streamed to an organization's sinks, at least once.
describe('Audit streaming (AUD-06)', () => {
  let app: FastifyInstance;
  let fx: Fixtures;
  const run = randomUUID().slice(0, 8);
  const org = `stream-${run}`;
  let orgId: string;
  let workspaceId: string;
  let alice: string;

  const db = () => app.container.systemDb;
  const quiet = { info() {}, warn() {}, error() {}, debug() {} } as never;
  const posts: Array<{ body: string; headers: Record<string, string> }> = [];
  let status = 200;
  const deps = (): StreamDeps => ({
    systemDb: db(),
    logger: quiet,
    encryptionKey: app.config.encryptionKey,
    checkUrl: async () => null,
    fetchImpl: (async (_url: string, init: RequestInit) => {
      posts.push({ body: String(init.body), headers: init.headers as Record<string, string> });
      return new Response('', { status });
    }) as unknown as typeof fetch,
  });
  const orgEvent = (action: string) =>
    db().organizationAuditEvent.create({
      data: {
        organizationId: orgId,
        actorType: 'system',
        actorId: 'test',
        action,
        resourceType: 'test',
        resourceId: action,
      },
    });
  const wsEvent = (action: string) =>
    db().auditEvent.create({
      data: {
        workspaceId,
        actorType: 'system',
        actorId: 'test',
        action,
        resourceType: 'test',
        resourceId: action,
      },
    });
  const sent = () => posts.flatMap((p) => JSON.parse(p.body).events as Array<{ action: string }>);

  beforeAll(async () => {
    app = await buildApp();
    await app.ready();
    fx = new Fixtures(app);
    alice = await fx.session(await fx.user());
    await app.inject({
      method: 'POST',
      url: '/api/orgs',
      payload: { name: org, slug: org },
      headers: bearer(alice),
    });
    orgId = (await db().organization.findUniqueOrThrow({ where: { slug: org } })).id;
    const { workspace } = await fx.workspace();
    workspaceId = workspace.id;
    await db().workspace.update({ where: { id: workspaceId }, data: { organizationId: orgId } });
  });

  afterAll(async () => {
    await db().auditEvent.deleteMany({ where: { workspaceId } });
    await fx.cleanup();
    await db().organization.deleteMany({ where: { slug: org } });
    await app.close();
  });

  it('sends org and workspace events in order, signed, and resumes from its cursor', async () => {
    await orgEvent('test.one');
    await wsEvent('test.two');
    await orgEvent('test.three');
    const created = await app.inject({
      method: 'POST',
      url: `/api/orgs/${org}/audit-sinks`,
      headers: bearer(alice),
      payload: { kind: 'https', name: 'SIEM', url: 'https://8.8.8.8/ingest', backfill: true },
    });
    expect(created.statusCode).toBe(201);
    const { id, secret } = created.json();
    expect(secret).toMatch(/^hss_/);
    const listed = await app.inject({
      method: 'GET',
      url: `/api/orgs/${org}/audit-sinks`,
      headers: bearer(alice),
    });
    expect(JSON.stringify(listed.json())).not.toContain(secret);

    posts.length = 0;
    await streamSink(deps(), id);
    const actions = sent().map((e) => e.action);
    // The sink's own creation (an org audit event) is part of the stream too.
    expect(actions.filter((a) => a.startsWith('test.'))).toEqual([
      'test.one',
      'test.two',
      'test.three',
    ]);
    const batch = JSON.parse(posts[0].body);
    expect(batch).toMatchObject({ sink: id, organization: org });
    expect(batch.events.find((e: { action: string }) => e.action === 'test.two')).toMatchObject({
      scope: 'workspace',
      hash: expect.any(String),
    });
    expect(posts[0].headers['X-Harmoniq-Signature']).toBe(
      createHmac('sha256', secret).update(posts[0].body).digest('hex')
    );

    // Nothing new, nothing sent; new events only.
    posts.length = 0;
    await streamSink(deps(), id);
    expect(posts).toHaveLength(0);
    await wsEvent('test.four');
    await streamSink(deps(), id);
    expect(sent().map((e) => e.action)).toEqual(['test.four']);
    await db().auditSink.update({ where: { id }, data: { enabled: false } });
  });

  it('resends a refused batch until accepted, then dead-letters it and moves on', async () => {
    const sink = await db().auditSink.create({
      data: {
        organizationId: orgId,
        kind: 'https',
        name: 'Flaky',
        config: sealSecret(
          JSON.stringify({ url: 'https://8.8.8.8/x', secret: 's' }),
          app.config.encryptionKey
        ),
        cursorAt: new Date(),
        cursorId: '',
      },
    });
    await orgEvent('test.flaky');
    posts.length = 0;
    status = 500;
    await streamSink(deps(), sink.id);
    let row = await db().auditSink.findUniqueOrThrow({ where: { id: sink.id } });
    expect(row).toMatchObject({ failures: 1, lastError: 'HTTP 500' });
    // The same batch again (at least once).
    status = 200;
    await streamSink(deps(), sink.id);
    expect(sent().map((e) => e.action)).toEqual(['test.flaky', 'test.flaky']);
    row = await db().auditSink.findUniqueOrThrow({ where: { id: sink.id } });
    expect(row).toMatchObject({ failures: 0, lastError: null });

    // Refused every time: set aside after MAX_FAILURES, and the stream moves on.
    await orgEvent('test.poison');
    status = 500;
    for (let i = 0; i < MAX_FAILURES; i++) await streamSink(deps(), sink.id);
    const letter = await db().auditSinkDeadLetter.findFirstOrThrow({ where: { sinkId: sink.id } });
    expect(letter).toMatchObject({ events: 1, error: 'HTTP 500' });
    row = await db().auditSink.findUniqueOrThrow({ where: { id: sink.id } });
    expect(row.cursorId).toBe(letter.toId);
    posts.length = 0;
    await orgEvent('test.after');
    status = 200;
    await streamSink(deps(), sink.id);
    expect(sent().map((e) => e.action)).toEqual(['test.after']);

    // The dead letter can be sent again.
    posts.length = 0;
    expect(await resendDeadLetter(deps(), letter.id)).toBe(1);
    expect(sent().map((e) => e.action)).toEqual(['test.poison']);
    expect(
      (await db().auditSinkDeadLetter.findUniqueOrThrow({ where: { id: letter.id } })).retriedAt
    ).not.toBeNull();
    await db().auditSink.update({ where: { id: sink.id }, data: { enabled: false } });
  });

  it('writes S3 objects per hour, named by their first event', async () => {
    const sink = await db().auditSink.create({
      data: {
        organizationId: orgId,
        kind: 's3',
        name: 'Bucket',
        config: sealSecret(
          JSON.stringify({
            bucket: 'audit',
            region: 'eu-west-1',
            prefix: 'logs/',
            accessKeyId: 'a',
            secretAccessKey: 'b',
          }),
          app.config.encryptionKey
        ),
        cursorAt: new Date(),
        cursorId: '',
      },
    });
    const old = await db().organizationAuditEvent.create({
      data: {
        organizationId: orgId,
        actorType: 'system',
        actorId: 'test',
        action: 'test.s3a',
        resourceType: 'test',
        resourceId: 'a',
        createdAt: new Date(Date.now() + 60_000),
      },
    });
    const later = await db().organizationAuditEvent.create({
      data: {
        organizationId: orgId,
        actorType: 'system',
        actorId: 'test',
        action: 'test.s3b',
        resourceType: 'test',
        resourceId: 'b',
        createdAt: new Date(Date.now() + 2 * 3_600_000),
      },
    });
    const objects: Array<{ key: string; body: string }> = [];
    await streamSink(
      {
        ...deps(),
        putObject: async (_c, key, body) => void objects.push({ key, body: body.toString() }),
      },
      sink.id
    );
    const hour = (d: Date) => d.toISOString().slice(0, 13).replace('T', '/').replace(/-/g, '/');
    expect(objects.map((o) => o.key)).toEqual([
      `logs/${org}/${hour(old.createdAt)}/${old.id}.jsonl`,
      `logs/${org}/${hour(later.createdAt)}/${later.id}.jsonl`,
    ]);
    expect(JSON.parse(objects[0].body.trim())).toMatchObject({
      action: 'test.s3a',
      scope: 'organization',
    });
  });

  it('starts from now unless the history is asked for', async () => {
    await orgEvent('test.before');
    const res = await app.inject({
      method: 'POST',
      url: `/api/orgs/${org}/audit-sinks`,
      headers: bearer(alice),
      payload: { kind: 'https', name: 'Fresh', url: 'https://8.8.8.8/fresh' },
    });
    posts.length = 0;
    await streamSink(deps(), res.json().id);
    expect(sent().map((e) => e.action)).not.toContain('test.before');
    expect(
      (
        await app.inject({
          method: 'POST',
          url: `/api/orgs/${org}/audit-sinks`,
          headers: bearer(alice),
          payload: { kind: 'https', name: 'Bad', url: 'http://10.0.0.1/x' },
        })
      ).statusCode
    ).toBe(400);
  });
});
