// Copyright The Harmoniq Authors
// SPDX-License-Identifier: Apache-2.0

import { createHmac } from 'crypto';
import type { AuditSink, PrismaClient } from '@prisma/client';
import type { ILogger } from '@harmoniq/core/dist/ports/ILogger';
import { S3StorageAdapter } from '../adapters/storage/S3StorageAdapter';
import { openSecret } from './crypto';
import type { FastifyInstance } from 'fastify';
import { checkPublicUrl, createSafeFetch, guardedHttpAgent, guardedHttpsAgent } from './outbound';

/**
 * AUD-06: an organization's audit events (its own and its workspaces', deleted ones too)
 * streamed to its sinks, oldest first, from each sink's cursor. A batch is resent until the
 * sink accepts it (at least once); after `MAX_FAILURES` attempts it is set aside as a dead
 * letter so the stream moves on, and can be sent again later.
 */

export const STREAM_BATCH = 500;
/** Batches per sink per run (every minute). */
const BATCHES_PER_RUN = 5;
export const MAX_FAILURES = 10;

export type HttpsSinkConfig = { url: string; secret: string };
export type S3SinkConfig = {
  bucket: string;
  region: string;
  endpoint?: string;
  prefix?: string;
  accessKeyId: string;
  secretAccessKey: string;
};

export interface StreamedEvent {
  id: string;
  scope: 'workspace' | 'organization';
  workspace: string | null;
  createdAt: string;
  actorType: string;
  actorId: string;
  action: string;
  resourceType: string;
  resourceId: string;
  metadata: unknown;
  ip: string | null;
  chainSeq: string | null;
  prevHash: string | null;
  hash: string | null;
}

type Position = { at: Date; id: string };
const after = (p: Position | null) =>
  p ? { OR: [{ createdAt: { gt: p.at } }, { createdAt: p.at, id: { gt: p.id } }] } : {};
const upTo = (p: Position) => ({
  OR: [{ createdAt: { lt: p.at } }, { createdAt: p.at, id: { lte: p.id } }],
});
const ORDER = [{ createdAt: 'asc' as const }, { id: 'asc' as const }];

export interface StreamDeps {
  systemDb: PrismaClient;
  logger: ILogger;
  encryptionKey: Buffer;
  fetchImpl: typeof fetch;
  checkUrl: (url: string) => Promise<string | null>;
  /** Tests replace the S3 writer. */
  putObject?: (config: S3SinkConfig, key: string, body: Buffer) => Promise<void>;
}

/** The registry's dependencies for streaming (routes and the `audit.stream` job). */
export function streamDeps(fastify: FastifyInstance): StreamDeps {
  const allowHttp = !fastify.config.isProduction;
  return {
    systemDb: fastify.container.systemDb,
    logger: fastify.container.logger,
    encryptionKey: fastify.config.encryptionKey,
    fetchImpl: createSafeFetch({ allowHttp }),
    checkUrl: (url) => checkPublicUrl(url, { allowHttp }),
  };
}

export function sinkConfig<T = HttpsSinkConfig | S3SinkConfig>(sink: AuditSink, key: Buffer): T {
  return JSON.parse(openSecret(sink.config, key)) as T;
}

/** The organization's events after `from` (and up to `to`), oldest first. */
export async function eventsAfter(
  db: PrismaClient,
  organizationId: string,
  from: Position | null,
  take: number,
  to?: Position
): Promise<StreamedEvent[]> {
  const workspaces = await db.workspace.findMany({
    where: { organizationId },
    select: { id: true, slug: true },
  });
  const slugOf = new Map(workspaces.map((w) => [w.id, w.slug]));
  const range = (extra: object) => ({ AND: [after(from), ...(to ? [upTo(to)] : []), extra] });
  const [ws, org] = await Promise.all([
    workspaces.length
      ? db.auditEvent.findMany({
          where: range({ workspaceId: { in: [...slugOf.keys()] } }),
          orderBy: ORDER,
          take,
        })
      : [],
    db.organizationAuditEvent.findMany({
      where: range({ organizationId }),
      orderBy: ORDER,
      take,
    }),
  ]);
  const rows = [
    ...ws.map((e) => ({
      ...e,
      scope: 'workspace' as const,
      workspace: slugOf.get(e.workspaceId) ?? null,
    })),
    ...org.map((e) => ({ ...e, scope: 'organization' as const, workspace: null })),
  ]
    .sort(
      (a, b) =>
        a.createdAt.getTime() - b.createdAt.getTime() || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
    )
    .slice(0, take);
  return rows.map((e) => ({
    id: e.id,
    scope: e.scope,
    workspace: e.workspace,
    createdAt: e.createdAt.toISOString(),
    actorType: e.actorType,
    actorId: e.actorId,
    action: e.action,
    resourceType: e.resourceType,
    resourceId: e.resourceId,
    metadata: e.metadata,
    ip: e.ip,
    chainSeq: e.chainSeq?.toString() ?? null,
    prevHash: e.prevHash,
    hash: e.hash,
  }));
}

/** `prefix/org/YYYY/MM/DD/HH/` of an event's hour (UTC). */
export function hourPrefix(prefix: string | undefined, org: string, iso: string) {
  const [date, time] = iso.split('T');
  const [y, m, d] = date.split('-');
  return `${prefix ? `${prefix.replace(/\/+$/, '')}/` : ''}${org}/${y}/${m}/${d}/${time.slice(0, 2)}/`;
}

async function defaultPutObject(config: S3SinkConfig, key: string, body: Buffer) {
  const adapter = new S3StorageAdapter(
    config.region,
    config.bucket,
    config.accessKeyId,
    config.secretAccessKey,
    config.endpoint,
    undefined,
    config.endpoint ? { httpAgent: guardedHttpAgent(), httpsAgent: guardedHttpsAgent() } : undefined
  );
  await adapter.put(key, body.toString('utf8'), { contentType: 'application/x-ndjson' });
}

/** Delivers one batch; throws when the sink refuses it. */
export async function deliverBatch(
  deps: StreamDeps,
  sink: AuditSink,
  org: string,
  events: StreamedEvent[],
  opts: { test?: boolean } = {}
) {
  if (sink.kind === 'https') {
    const config = sinkConfig<HttpsSinkConfig>(sink, deps.encryptionKey);
    const blocked = await deps.checkUrl(config.url);
    if (blocked) throw new Error(`Blocked: ${blocked}`);
    const body = JSON.stringify({
      sink: sink.id,
      organization: org,
      ...(opts.test && { test: true }),
      events,
    });
    const res = await deps.fetchImpl(config.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        // HMAC-SHA256 of the body with the sink's secret, as for webhooks.
        'X-Harmoniq-Signature': createHmac('sha256', config.secret).update(body).digest('hex'),
        'X-Harmoniq-Batch': events.length ? `${events[0].id}..${events.at(-1)!.id}` : 'test',
      },
      body,
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return;
  }
  const config = sinkConfig<S3SinkConfig>(sink, deps.encryptionKey);
  if (config.endpoint) {
    const blocked = await deps.checkUrl(config.endpoint);
    if (blocked) throw new Error(`Blocked: ${blocked}`);
  }
  const put = deps.putObject ?? defaultPutObject;
  if (opts.test) {
    await put(
      config,
      `${hourPrefix(config.prefix, org, new Date().toISOString())}_harmoniq-test.json`,
      Buffer.from('{"test":true}\n')
    );
    return;
  }
  // One object per hour of events, named by its first event (a resent batch overwrites it).
  const byHour = new Map<string, StreamedEvent[]>();
  for (const e of events) {
    const key = hourPrefix(config.prefix, org, e.createdAt);
    byHour.set(key, [...(byHour.get(key) ?? []), e]);
  }
  for (const [prefix, group] of byHour) {
    await put(
      config,
      `${prefix}${group[0].id}.jsonl`,
      Buffer.from(group.map((e) => JSON.stringify(e)).join('\n') + '\n')
    );
  }
}

/** Streams what one sink is owed, a few batches at a time. */
export async function streamSink(deps: StreamDeps, sinkId: string) {
  const { systemDb, logger } = deps;
  let delivered = 0;
  for (let i = 0; i < BATCHES_PER_RUN; i++) {
    const sink = await systemDb.auditSink.findUnique({
      where: { id: sinkId },
      include: { organization: { select: { slug: true, deletedAt: true } } },
    });
    if (!sink || !sink.enabled || sink.organization.deletedAt) return delivered;
    // A cursor of (time, '') starts at that time (a sink created without backfill).
    const cursor = sink.cursorAt ? { at: sink.cursorAt, id: sink.cursorId ?? '' } : null;
    const events = await eventsAfter(systemDb, sink.organizationId, cursor, STREAM_BATCH);
    if (!events.length) return delivered;
    const last = events.at(-1)!;
    const next = { cursorAt: new Date(last.createdAt), cursorId: last.id };
    try {
      await deliverBatch(deps, sink, sink.organization.slug, events);
      await systemDb.auditSink.update({
        where: { id: sink.id },
        data: { ...next, failures: 0, lastError: null, lastDeliveredAt: new Date() },
      });
      delivered += events.length;
    } catch (err) {
      const error = (err as Error).message.slice(0, 500);
      const failures = sink.failures + 1;
      if (failures >= MAX_FAILURES) {
        // Set the batch aside and move on; it can be sent again (dead letters).
        await systemDb.$transaction([
          systemDb.auditSinkDeadLetter.create({
            data: {
              sinkId: sink.id,
              organizationId: sink.organizationId,
              fromAt: new Date(events[0].createdAt),
              fromId: events[0].id,
              toAt: next.cursorAt,
              toId: next.cursorId,
              events: events.length,
              error,
            },
          }),
          systemDb.auditSink.update({
            where: { id: sink.id },
            data: { ...next, failures: 0, lastError: error },
          }),
        ]);
        logger.warn(`Audit sink ${sink.id}: ${events.length} events dead-lettered (${error})`);
      } else {
        await systemDb.auditSink.update({
          where: { id: sink.id },
          data: { failures, lastError: error },
        });
        logger.warn(`Audit sink ${sink.id} failed (${failures}/${MAX_FAILURES}): ${error}`);
      }
      return delivered;
    }
  }
  return delivered;
}

/** `audit.stream`: every enabled sink. */
export async function streamAll(deps: StreamDeps) {
  const sinks = await deps.systemDb.auditSink.findMany({
    where: { enabled: true, organization: { deletedAt: null } },
    select: { id: true },
  });
  let total = 0;
  for (const s of sinks) total += await streamSink(deps, s.id);
  return { sinks: sinks.length, events: total };
}

/** Sends a dead-lettered batch again; throws when the sink still refuses it. */
export async function resendDeadLetter(deps: StreamDeps, deadLetterId: string) {
  const letter = await deps.systemDb.auditSinkDeadLetter.findUniqueOrThrow({
    where: { id: deadLetterId },
    include: { sink: { include: { organization: { select: { slug: true } } } } },
  });
  // From the event before the first: `eventsAfter` is exclusive, so include `from` itself.
  const events = (
    await eventsAfter(
      deps.systemDb,
      letter.organizationId,
      { at: new Date(letter.fromAt.getTime() - 1), id: '' },
      letter.events + STREAM_BATCH,
      { at: letter.toAt, id: letter.toId }
    )
  ).filter(
    (e) =>
      new Date(e.createdAt) > letter.fromAt ||
      (new Date(e.createdAt).getTime() === letter.fromAt.getTime() && e.id >= letter.fromId)
  );
  await deliverBatch(deps, letter.sink, letter.sink.organization.slug, events);
  await deps.systemDb.auditSinkDeadLetter.update({
    where: { id: letter.id },
    data: { retriedAt: new Date() },
  });
  return events.length;
}
