// Copyright The Harmoniq Authors
// SPDX-License-Identifier: Apache-2.0

import { FastifyPluginAsync, FastifyRequest } from 'fastify';
import type { Prisma } from '@prisma/client';
import { BadRequestError, NotFoundError } from '@harmoniq/core/dist/errors/AppError';
import type { Manifest } from '@harmoniq/core/dist/schemas/ManifestSchema';
import { diffManifests } from '@harmoniq/core/dist/manifest/diff';
import { audit } from '../services/audit';
import {
  NEWEST_FIRST,
  afterWhere,
  dateRange,
  exportFormat,
  keysetRows,
  sendExport,
} from '../services/auditExport';

type WsParams = { workspaceSlug: string };
type EnvParams = WsParams & { hostAppSlug: string; env: string };

const pageSize = (raw?: string) => Math.min(Math.max(Number(raw) || 50, 1), 200);

const historyRoutes: FastifyPluginAsync = async (fastify) => {
  const { withTenant } = fastify.container;

  // ─── Audit log (AUD-03) ───────────────────────────────────────────────────

  fastify.get<{
    Params: WsParams;
    Querystring: {
      actor?: string;
      action?: string;
      resourceId?: string;
      from?: string;
      to?: string;
      cursor?: string;
      limit?: string;
    };
  }>(
    '/api/workspaces/:workspaceSlug/audit',
    { preHandler: fastify.requireWorkspace('workspace:read') },
    async (request) => {
      const q = request.query;
      const limit = pageSize(q.limit);
      const where: Prisma.AuditEventWhereInput = {
        ...(q.actor && { actorId: q.actor }),
        // `module.` matches every module action; an exact name matches one.
        ...(q.action &&
          (q.action.endsWith('.') ? { action: { startsWith: q.action } } : { action: q.action })),
        ...(q.resourceId && { resourceId: q.resourceId }),
        ...((q.from || q.to) && {
          createdAt: {
            ...(q.from && { gte: new Date(q.from) }),
            ...(q.to && { lte: new Date(q.to) }),
          },
        }),
      };
      const events = await withTenant(request.workspace!.id, (tx) =>
        tx.auditEvent.findMany({
          where,
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          take: limit + 1,
          ...(q.cursor && { cursor: { id: q.cursor }, skip: 1 }),
        })
      );
      const page = events.slice(0, limit);
      return {
        events: page.map((e) => ({
          id: e.id,
          action: e.action,
          actorId: e.actorId,
          actorType: e.actorType,
          resourceType: e.resourceType,
          resourceId: e.resourceId,
          metadata: e.metadata,
          ip: e.ip,
          createdAt: e.createdAt.toISOString(),
        })),
        nextCursor: events.length > limit ? page[page.length - 1].id : null,
      };
    }
  );

  /** Compliance export: every matching event as CSV or JSON Lines (admins). */
  fastify.get<{
    Params: WsParams;
    Querystring: { format?: string; actor?: string; action?: string; from?: string; to?: string };
  }>(
    '/api/workspaces/:workspaceSlug/audit/export',
    { preHandler: fastify.requireWorkspace('workspace:admin') },
    async (request, reply) => {
      const workspace = request.workspace!;
      const q = request.query;
      const format = exportFormat(q.format);
      const where: Prisma.AuditEventWhereInput = {
        workspaceId: workspace.id,
        ...(q.actor && { actorId: q.actor }),
        ...(q.action &&
          (q.action.endsWith('.') ? { action: { startsWith: q.action } } : { action: q.action })),
        ...dateRange(q),
      };
      // Who exported what is part of the record.
      await withTenant(workspace.id, (tx) =>
        audit(
          tx,
          workspace.id,
          { principal: request.principal!, ip: request.ip },
          {
            action: 'audit.export',
            resourceType: 'workspace',
            resourceId: workspace.id,
            metadata: {
              format,
              filters: { actor: q.actor, action: q.action, from: q.from, to: q.to },
            },
          }
        )
      );
      const rows = keysetRows((after, take) =>
        withTenant(workspace.id, (tx) =>
          tx.auditEvent.findMany({
            where: { ...where, ...afterWhere(after) },
            orderBy: NEWEST_FIRST,
            take,
          })
        )
      );
      return sendExport(reply, rows, { format, name: workspace.slug, workspaceColumn: false });
    }
  );

  // ─── Snapshots & diff (SNAP-02/03, DIFF-01) ───────────────────────────────

  async function environmentFor(request: FastifyRequest<{ Params: EnvParams }>) {
    const workspace = request.workspace!;
    const { hostAppSlug, env } = request.params;
    const environment = await withTenant(workspace.id, async (tx) => {
      const hostApp = await tx.hostApp.findUnique({
        where: { workspaceId_slug: { workspaceId: workspace.id, slug: hostAppSlug } },
      });
      return hostApp
        ? tx.environment.findUnique({
            where: { hostAppId_slug: { hostAppId: hostApp.id, slug: env } },
          })
        : null;
    });
    if (!environment) throw new NotFoundError('Environment not found');
    return environment;
  }

  fastify.get<{ Params: EnvParams; Querystring: { cursor?: string; limit?: string } }>(
    '/api/manifest/:workspaceSlug/:hostAppSlug/:env/snapshots',
    { preHandler: fastify.requireWorkspace('workspace:read') },
    async (request) => {
      const environment = await environmentFor(request);
      const limit = pageSize(request.query.limit);
      const snapshots = await withTenant(request.workspace!.id, (tx) =>
        tx.manifestSnapshot.findMany({
          where: { environmentId: environment.id, deletedAt: null },
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          take: limit + 1,
          ...(request.query.cursor && { cursor: { id: request.query.cursor }, skip: 1 }),
          select: { id: true, etag: true, createdAt: true, auditEventId: true },
        })
      );
      const page = snapshots.slice(0, limit);
      const auditEvents = await withTenant(request.workspace!.id, (tx) =>
        tx.auditEvent.findMany({ where: { id: { in: page.map((s) => s.auditEventId) } } })
      );
      const byId = new Map(auditEvents.map((e) => [e.id, e]));
      return {
        snapshots: page.map((s) => {
          const cause = byId.get(s.auditEventId);
          return {
            id: s.id,
            etag: s.etag,
            createdAt: s.createdAt.toISOString(),
            cause: cause && {
              action: cause.action,
              actorId: cause.actorId,
              actorType: cause.actorType,
              metadata: cause.metadata,
            },
          };
        }),
        nextCursor: snapshots.length > limit ? page[page.length - 1].id : null,
      };
    }
  );

  fastify.get<{ Params: EnvParams & { snapshotId: string } }>(
    '/api/manifest/:workspaceSlug/:hostAppSlug/:env/snapshots/:snapshotId',
    { preHandler: fastify.requireWorkspace('workspace:read') },
    async (request) => {
      const environment = await environmentFor(request);
      const snapshot = await withTenant(request.workspace!.id, (tx) =>
        tx.manifestSnapshot.findFirst({
          where: { id: request.params.snapshotId, environmentId: environment.id, deletedAt: null },
        })
      );
      if (!snapshot) throw new NotFoundError('Snapshot not found');
      return snapshot.manifestJson;
    }
  );

  // `to` defaults to the latest snapshot ("what changed since X?").
  fastify.get<{ Params: EnvParams; Querystring: { from?: string; to?: string } }>(
    '/api/manifest/:workspaceSlug/:hostAppSlug/:env/diff',
    { preHandler: fastify.requireWorkspace('workspace:read') },
    async (request) => {
      const { from, to } = request.query;
      if (!from) throw new BadRequestError('`from` snapshot id is required');
      const environment = await environmentFor(request);
      const [fromSnap, toSnap] = await withTenant(request.workspace!.id, async (tx) => [
        await tx.manifestSnapshot.findFirst({ where: { id: from, environmentId: environment.id } }),
        to
          ? await tx.manifestSnapshot.findFirst({
              where: { id: to, environmentId: environment.id },
            })
          : await tx.manifestSnapshot.findFirst({
              where: { environmentId: environment.id, deletedAt: null },
              orderBy: { createdAt: 'desc' },
            }),
      ]);
      if (!fromSnap || !toSnap) throw new NotFoundError('Snapshot not found');
      return {
        from: { id: fromSnap.id, createdAt: fromSnap.createdAt.toISOString(), etag: fromSnap.etag },
        to: { id: toSnap.id, createdAt: toSnap.createdAt.toISOString(), etag: toSnap.etag },
        ...diffManifests(
          fromSnap.manifestJson as unknown as Manifest,
          toSnap.manifestJson as unknown as Manifest
        ),
      };
    }
  );
};

export default historyRoutes;
