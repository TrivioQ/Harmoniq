// Copyright The Harmoniq Authors
// SPDX-License-Identifier: Apache-2.0
/* eslint-disable no-restricted-syntax -- MT-09: instance administration spans every tenant (INST-36, INST-39) */

import { FastifyPluginAsync } from 'fastify';
import { BadRequestError } from '@harmoniq/core/dist/errors/AppError';
import { actorOf, actorWhere, parseDate, resolveActors } from '../services/auditActors';

/**
 * INST-36: one actor across every audit log. INST-39: sign-in failures, rate limits,
 * rejected keys and SCIM errors, for the security page.
 */

const DAY = 86_400_000;
const TOP = 20;

const adminSecurityRoutes: FastifyPluginAsync = async (fastify) => {
  const { systemDb } = fastify.container;
  const admin = { preHandler: fastify.requireInstanceAdmin };

  /** Workspace, organization and instance events of one actor, newest first (audited). */
  fastify.get<{ Querystring: { actor?: string; from?: string; to?: string; limit?: string } }>(
    '/api/admin/audit/search',
    admin,
    async (request) => {
      const q = request.query;
      const actor = q.actor?.trim();
      if (!actor) throw new BadRequestError('actor (an email or id) is required');
      const from = parseDate(q.from);
      const to = parseDate(q.to);
      const take = Math.min(500, Math.max(1, Number(q.limit) || 100));
      const who = await actorWhere(systemDb, actor);
      const where = { ...who, ...((from || to) && { createdAt: { gte: from, lte: to } }) };
      const [ws, orgs, inst] = await Promise.all([
        systemDb.auditEvent.findMany({ where, orderBy: { createdAt: 'desc' }, take }),
        systemDb.organizationAuditEvent.findMany({ where, orderBy: { createdAt: 'desc' }, take }),
        systemDb.instanceAuditEvent.findMany({ where, orderBy: { createdAt: 'desc' }, take }),
      ]);
      const [wsSlugs, orgSlugs, actors] = await Promise.all([
        systemDb.workspace.findMany({
          where: { id: { in: [...new Set(ws.map((e) => e.workspaceId))] } },
          select: { id: true, slug: true },
        }),
        systemDb.organization.findMany({
          where: { id: { in: [...new Set(orgs.map((e) => e.organizationId))] } },
          select: { id: true, slug: true },
        }),
        resolveActors(systemDb, [...ws, ...orgs, ...inst]),
      ]);
      const slug = (rows: Array<{ id: string; slug: string }>, id: string) =>
        rows.find((r) => r.id === id)?.slug ?? null;
      const events = [
        ...ws.map((e) => ({ ...e, scope: 'workspace', tenant: slug(wsSlugs, e.workspaceId) })),
        ...orgs.map((e) => ({
          ...e,
          scope: 'organization',
          tenant: slug(orgSlugs, e.organizationId),
        })),
        ...inst.map((e) => ({ ...e, scope: 'instance', tenant: null })),
      ]
        .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
        .slice(0, take)
        .map((e) => ({
          id: e.id,
          scope: e.scope,
          tenant: e.tenant,
          action: e.action,
          actor: actorOf(actors, e),
          resourceType: e.resourceType,
          resourceId: e.resourceId,
          metadata: e.metadata,
          ip: e.ip,
          createdAt: e.createdAt.toISOString(),
        }));
      // Looking someone up across tenants is itself recorded.
      await systemDb.instanceAuditEvent.create({
        data: {
          actorType: request.principal!.type === 'apiKey' ? 'apiKey' : 'user',
          actorId: request.principal!.id,
          ip: request.ip,
          action: 'instance.audit_search',
          resourceType: 'actor',
          resourceId: actor.slice(0, 320),
          metadata: { results: events.length },
        },
      });
      return { events };
    }
  );

  /** The security page: the last `days` (1–90, default 7). */
  fastify.get<{ Querystring: { days?: string } }>('/api/admin/security', admin, async (request) => {
    const days = Math.min(90, Math.max(1, Number(request.query.days) || 7));
    const since = new Date(Date.now() - days * DAY);
    const failed = { success: false, createdAt: { gte: since }, method: { not: 'api_key' } };
    const [byIp, byEmail, totals, recent, keys, limited, scim] = await Promise.all([
      systemDb.signInEvent.groupBy({
        by: ['ip'],
        where: failed,
        _count: { _all: true },
        _max: { createdAt: true },
        orderBy: { _count: { ip: 'desc' } },
        take: TOP,
      }),
      systemDb.signInEvent.groupBy({
        by: ['email'],
        where: { ...failed, email: { not: null } },
        _count: { _all: true },
        _max: { createdAt: true },
        orderBy: { _count: { email: 'desc' } },
        take: TOP,
      }),
      systemDb.signInEvent.groupBy({
        by: ['success'],
        where: { createdAt: { gte: since }, method: { not: 'api_key' } },
        _count: { _all: true },
      }),
      systemDb.signInEvent.findMany({
        where: failed,
        orderBy: { createdAt: 'desc' },
        take: 50,
      }),
      systemDb.signInEvent.groupBy({
        by: ['keyPrefix', 'reason'],
        where: { method: 'api_key', createdAt: { gte: since } },
        _count: { _all: true },
        _max: { createdAt: true },
        orderBy: { _count: { keyPrefix: 'desc' } },
        take: TOP,
      }),
      systemDb.usageDaily.groupBy({
        by: ['workspaceId'],
        where: { day: { gte: since }, rateLimited: { gt: 0 } },
        _sum: { rateLimited: true },
        orderBy: { _sum: { rateLimited: 'desc' } },
        take: TOP,
      }),
      systemDb.scimAuditEvent.findMany({
        where: { statusCode: { gte: 400 }, createdAt: { gte: since } },
        orderBy: { createdAt: 'desc' },
        take: 50,
      }),
    ]);
    const [workspaces, orgs] = await Promise.all([
      systemDb.workspace.findMany({
        where: {
          id: {
            in: [
              ...limited.map((l) => l.workspaceId),
              ...scim.flatMap((s) => (s.workspaceId ? [s.workspaceId] : [])),
            ],
          },
        },
        select: { id: true, slug: true },
      }),
      systemDb.organization.findMany({
        where: { id: { in: scim.flatMap((s) => (s.organizationId ? [s.organizationId] : [])) } },
        select: { id: true, slug: true },
      }),
    ]);
    const wsSlug = new Map(workspaces.map((w) => [w.id, w.slug]));
    const orgSlug = new Map(orgs.map((o) => [o.id, o.slug]));
    const iso = (d: Date | null) => d?.toISOString() ?? null;
    return {
      days,
      signIns: {
        succeeded: totals.find((t) => t.success)?._count._all ?? 0,
        failed: totals.find((t) => !t.success)?._count._all ?? 0,
      },
      failedByIp: byIp.map((r) => ({
        ip: r.ip,
        failures: r._count._all,
        lastAt: iso(r._max.createdAt),
      })),
      failedByEmail: byEmail.map((r) => ({
        email: r.email,
        failures: r._count._all,
        lastAt: iso(r._max.createdAt),
      })),
      recentFailures: recent.map((r) => ({
        email: r.email,
        method: r.method,
        reason: r.reason,
        ip: r.ip,
        createdAt: r.createdAt.toISOString(),
      })),
      rejectedKeys: keys.map((k) => ({
        prefix: k.keyPrefix,
        reason: k.reason,
        attempts: k._count._all,
        lastAt: iso(k._max.createdAt),
      })),
      rateLimitedWorkspaces: limited.flatMap((l) => {
        const slug = wsSlug.get(l.workspaceId);
        return slug ? [{ workspace: slug, requests: l._sum.rateLimited ?? 0 }] : [];
      }),
      scimErrors: scim.map((s) => ({
        tenant: s.workspaceId
          ? { type: 'workspace', slug: wsSlug.get(s.workspaceId) ?? null }
          : {
              type: 'organization',
              slug: s.organizationId ? (orgSlug.get(s.organizationId) ?? null) : null,
            },
        operation: s.operation,
        statusCode: s.statusCode,
        createdAt: s.createdAt.toISOString(),
      })),
    };
  });
};

export default adminSecurityRoutes;
