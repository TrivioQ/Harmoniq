// Copyright The Harmoniq Authors
// SPDX-License-Identifier: Apache-2.0

import { randomBytes } from 'crypto';
import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { AuditSink } from '@prisma/client';
import type { TenantTx } from '@harmoniq/db';
import { BadRequestError, NotFoundError } from '@harmoniq/core/dist/errors/AppError';
import {
  CreateAuditSinkSchema,
  UpdateAuditSinkSchema,
} from '@harmoniq/core/dist/schemas/OrgEventsSchema';
import { sealSecret } from '../services/crypto';
import { checkPublicUrl } from '../services/outbound';
import {
  type HttpsSinkConfig,
  type S3SinkConfig,
  type StreamDeps,
  deliverBatch,
  resendDeadLetter,
  sinkConfig,
  streamDeps,
} from '../services/auditStream';

type OrgParams = { orgSlug: string };
type Handler = (request: FastifyRequest, reply: FastifyReply) => Promise<unknown>;
type OrgAudit = (
  request: FastifyRequest,
  event: {
    action: string;
    resourceType: string;
    resourceId: string;
    metadata?: Record<string, unknown>;
  },
  tx?: TenantTx
) => Promise<unknown>;

/** AUD-06: an organization's audit sinks (org admins). Secrets are never returned. */
export function orgAuditSinkRoutes(
  fastify: FastifyInstance,
  deps: { admin: { preHandler: Handler }; orgAudit: OrgAudit; stream?: () => StreamDeps }
) {
  const { withOrg } = fastify.container;
  const { encryptionKey } = fastify.config;
  const allowHttp = !fastify.config.isProduction;
  const stream = deps.stream ?? (() => streamDeps(fastify));
  const inOrg = <T>(request: FastifyRequest, fn: (tx: TenantTx) => Promise<T>) =>
    withOrg(request.org!.id, fn);
  const { admin } = deps;

  const dto = (s: AuditSink & { _count?: { DeadLetters: number } }) => {
    const config = sinkConfig<HttpsSinkConfig & S3SinkConfig>(s, encryptionKey);
    return {
      id: s.id,
      kind: s.kind,
      name: s.name,
      enabled: s.enabled,
      // Where it goes, without credentials.
      target:
        s.kind === 'https'
          ? config.url
          : `s3://${config.bucket}/${config.prefix ?? ''}${config.endpoint ? ` (${config.endpoint})` : ''}`,
      cursorAt: s.cursorAt?.toISOString() ?? null,
      lastDeliveredAt: s.lastDeliveredAt?.toISOString() ?? null,
      failures: s.failures,
      lastError: s.lastError,
      deadLetters: s._count?.DeadLetters ?? 0,
      createdAt: s.createdAt.toISOString(),
    };
  };
  const find = async (tx: TenantTx, id: string) => {
    const sink = await tx.auditSink.findFirst({ where: { id } });
    if (!sink) throw new NotFoundError('Audit sink not found');
    return sink;
  };

  fastify.get<{ Params: OrgParams }>('/api/orgs/:orgSlug/audit-sinks', admin, async (request) => {
    const sinks = await inOrg(request, (tx) =>
      tx.auditSink.findMany({
        orderBy: { createdAt: 'asc' },
        include: { _count: { select: { DeadLetters: { where: { retriedAt: null } } } } },
      })
    );
    return { sinks: sinks.map(dto) };
  });

  fastify.post<{ Params: OrgParams }>(
    '/api/orgs/:orgSlug/audit-sinks',
    admin,
    async (request, reply) => {
      const body = CreateAuditSinkSchema.parse(request.body);
      const check = async (url: string) => {
        const blocked = await checkPublicUrl(url, { allowHttp });
        if (blocked) throw new BadRequestError(`URL rejected: ${blocked}`);
      };
      let config: HttpsSinkConfig | S3SinkConfig;
      let secret: string | undefined;
      if (body.kind === 'https') {
        await check(body.url);
        secret = `hss_${randomBytes(32).toString('base64url')}`;
        config = { url: body.url, secret };
      } else {
        if (body.endpoint) await check(body.endpoint);
        config = {
          bucket: body.bucket,
          region: body.region,
          endpoint: body.endpoint,
          prefix: body.prefix,
          accessKeyId: body.accessKeyId,
          secretAccessKey: body.secretAccessKey,
        };
      }
      const sink = await inOrg(request, async (tx) => {
        const created = await tx.auditSink.create({
          data: {
            organizationId: request.org!.id,
            kind: body.kind,
            name: body.name,
            config: sealSecret(JSON.stringify(config), encryptionKey),
            // From now on, unless the history is wanted too.
            ...(!body.backfill && { cursorAt: new Date(), cursorId: '' }),
          },
        });
        await deps.orgAudit(
          request,
          {
            action: 'org.audit_sink_create',
            resourceType: 'audit_sink',
            resourceId: created.id,
            metadata: { kind: body.kind, name: body.name, backfill: body.backfill },
          },
          tx
        );
        return created;
      });
      // The HTTPS signing secret is shown once.
      return reply.code(201).send({ ...dto(sink), ...(secret && { secret }) });
    }
  );

  fastify.patch<{ Params: OrgParams & { id: string } }>(
    '/api/orgs/:orgSlug/audit-sinks/:id',
    admin,
    async (request) => {
      const body = UpdateAuditSinkSchema.parse(request.body);
      return inOrg(request, async (tx) => {
        const sink = await find(tx, request.params.id);
        const updated = await tx.auditSink.update({
          where: { id: sink.id },
          // Turning it back on retries at once.
          data: { ...body, ...(body.enabled && { failures: 0 }) },
        });
        await deps.orgAudit(
          request,
          {
            action: 'org.audit_sink_update',
            resourceType: 'audit_sink',
            resourceId: sink.id,
            metadata: body,
          },
          tx
        );
        return dto(updated);
      });
    }
  );

  fastify.delete<{ Params: OrgParams & { id: string } }>(
    '/api/orgs/:orgSlug/audit-sinks/:id',
    admin,
    async (request, reply) => {
      await inOrg(request, async (tx) => {
        const sink = await find(tx, request.params.id);
        await tx.auditSink.delete({ where: { id: sink.id } });
        await deps.orgAudit(
          request,
          { action: 'org.audit_sink_delete', resourceType: 'audit_sink', resourceId: sink.id },
          tx
        );
      });
      return reply.code(204).send();
    }
  );

  /** Sends an empty test batch (HTTPS) or a test object (S3) now. */
  fastify.post<{ Params: OrgParams & { id: string } }>(
    '/api/orgs/:orgSlug/audit-sinks/:id/test',
    admin,
    async (request) => {
      const sink = await inOrg(request, (tx) => find(tx, request.params.id));
      try {
        await deliverBatch(stream(), sink, request.org!.slug, [], { test: true });
        return { ok: true };
      } catch (err) {
        return { ok: false, error: (err as Error).message };
      }
    }
  );

  fastify.get<{ Params: OrgParams & { id: string } }>(
    '/api/orgs/:orgSlug/audit-sinks/:id/dead-letters',
    admin,
    async (request) => {
      const letters = await inOrg(request, (tx) =>
        tx.auditSinkDeadLetter.findMany({
          where: { sinkId: request.params.id },
          orderBy: { createdAt: 'desc' },
          take: 100,
        })
      );
      return {
        deadLetters: letters.map((l) => ({
          id: l.id,
          from: l.fromAt.toISOString(),
          to: l.toAt.toISOString(),
          events: l.events,
          error: l.error,
          createdAt: l.createdAt.toISOString(),
          retriedAt: l.retriedAt?.toISOString() ?? null,
        })),
      };
    }
  );

  fastify.post<{ Params: OrgParams & { id: string; letterId: string } }>(
    '/api/orgs/:orgSlug/audit-sinks/:id/dead-letters/:letterId/retry',
    admin,
    async (request) => {
      await inOrg(request, async (tx) => {
        const found = await tx.auditSinkDeadLetter.findFirst({
          where: { id: request.params.letterId, sinkId: request.params.id },
        });
        if (!found) throw new NotFoundError('Dead letter not found');
      });
      try {
        const events = await resendDeadLetter(stream(), request.params.letterId);
        return { ok: true, events };
      } catch (err) {
        return { ok: false, error: (err as Error).message };
      }
    }
  );
}
