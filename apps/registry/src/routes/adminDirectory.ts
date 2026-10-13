// Copyright The Harmoniq Authors
// SPDX-License-Identifier: Apache-2.0
/* eslint-disable no-restricted-syntax -- MT-09: instance administration spans every tenant (INST-19, 29, 30) */

import { createHash, randomBytes } from 'crypto';
import { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { BadRequestError, ConflictError, NotFoundError } from '@harmoniq/core/dist/errors/AppError';
import { AuthService } from '../services/authService';
import { actorOf, resolveActors } from '../services/auditActors';
import { csvCell } from '../services/auditExport';
import { activeGrantsOn } from '../services/supportGrants';
import { usageTotals, workspaceUsage } from '../services/usageReport';
import { effectiveSso } from '../services/ssoIds';

/**
 * INST-19, INST-21, INST-29, INST-30: the instance's organizations, workspaces and users
 * for instance admins: lists with filters, sorting and CSV, and a detail view of each.
 * (Changes to them stay in `admin.ts`; account changes, email and merge, are here.)
 */

const PAGE = 50;
const DAY = 86_400_000;
const sha256 = (v: string) => createHash('sha256').update(v).digest('hex');
const iso = (d: Date | null | undefined) => d?.toISOString() ?? null;

/** Pages are offsets (`cursor` is the next one), so any sort can be paged. */
function page(cursor: string | undefined) {
  if (!cursor) return 0;
  const n = Number(cursor);
  if (!Number.isInteger(n) || n < 0) throw new BadRequestError('Invalid cursor');
  return n;
}
const positiveInt = (v: string | undefined) => {
  if (!v) return undefined;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1) throw new BadRequestError(`Not a positive number: ${v}`);
  return n;
};

function sendCsv(reply: FastifyReply, name: string, columns: string[], rows: unknown[][]) {
  const lines = [columns.join(','), ...rows.map((r) => r.map(csvCell).join(','))];
  return reply
    .header('Content-Type', 'text/csv; charset=utf-8')
    .header(
      'Content-Disposition',
      `attachment; filename="harmoniq-${name}-${new Date().toISOString().slice(0, 10)}.csv"`
    )
    .header('Cache-Control', 'no-store')
    .send(lines.join('\n') + '\n');
}

const ORG_RANK: Record<string, number> = {
  org_member: 1,
  org_billing: 2,
  org_auditor: 2,
  org_admin: 3,
};
const WS_RANK: Record<string, number> = { viewer: 1, developer: 2, admin: 3, owner: 4 };

const adminDirectoryRoutes: FastifyPluginAsync = async (fastify) => {
  const { systemDb, plans, quotas } = fastify.container;
  const admin = { preHandler: fastify.requireInstanceAdmin };
  const auth = new AuthService(systemDb, fastify.config.jwtSecret, fastify.container.logger);

  const instanceAudit = (
    request: FastifyRequest,
    event: { action: string; resourceType: string; resourceId: string; metadata?: object }
  ) =>
    systemDb.instanceAuditEvent.create({
      data: {
        actorType: request.principal!.type === 'apiKey' ? 'apiKey' : 'user',
        actorId: request.principal!.id,
        ip: request.ip,
        ...event,
        metadata: event.metadata as Prisma.InputJsonValue | undefined,
      },
    });

  /** The latest events of one tenant, with readable actors. */
  async function recentAudit(where: { workspaceId: string } | { organizationId: string }) {
    const events =
      'workspaceId' in where
        ? await systemDb.auditEvent.findMany({ where, orderBy: { createdAt: 'desc' }, take: 20 })
        : await systemDb.organizationAuditEvent.findMany({
            where,
            orderBy: { createdAt: 'desc' },
            take: 20,
          });
    const actors = await resolveActors(systemDb, events);
    return events.map((e) => ({
      id: e.id,
      action: e.action,
      actor: actorOf(actors, e),
      resourceType: e.resourceType,
      resourceId: e.resourceId,
      metadata: e.metadata,
      createdAt: e.createdAt.toISOString(),
    }));
  }

  // ─── Workspaces (INST-09, INST-21, INST-29) ───────────────────────────────

  type WorkspaceQuery = {
    query?: string;
    status?: 'active' | 'suspended' | 'deleted';
    plan?: string;
    org?: string;
    inactiveDays?: string;
    sort?: 'created' | 'name' | 'lastDeploy' | 'storage';
    order?: 'asc' | 'desc';
    cursor?: string;
    format?: string;
  };

  fastify.get<{ Querystring: WorkspaceQuery }>(
    '/api/admin/workspaces',
    admin,
    async (request, reply) => {
      const q = request.query;
      const text = q.query?.trim();
      const where: Prisma.WorkspaceWhereInput = {
        ...(text && {
          OR: [
            { slug: { contains: text, mode: 'insensitive' } },
            { name: { contains: text, mode: 'insensitive' } },
          ],
        }),
        ...(q.status === 'active' && { deletedAt: null, suspendedAt: null }),
        ...(q.status === 'suspended' && { deletedAt: null, suspendedAt: { not: null } }),
        ...(q.status === 'deleted' && { deletedAt: { not: null } }),
        ...(q.org === 'none'
          ? { organizationId: null }
          : q.org
            ? { organization: { slug: q.org } }
            : {}),
        ...(q.plan && {
          AND: [
            {
              OR: [
                { WorkspaceConfig: { plan: q.plan } },
                ...(q.plan === 'hobby' ? [{ WorkspaceConfig: null }] : []),
              ],
            },
          ],
        }),
      };
      const candidates = await systemDb.workspace.findMany({
        where,
        select: { id: true, name: true, createdAt: true },
      });
      const ids = candidates.map((w) => w.id);
      const versions = ids.length
        ? await systemDb.moduleVersion.groupBy({
            by: ['workspaceId'],
            where: { workspaceId: { in: ids } },
            _max: { deployedAt: true },
          })
        : [];
      const storage = ids.length
        ? await systemDb.moduleVersion.groupBy({
            by: ['workspaceId'],
            where: { workspaceId: { in: ids }, deletedAt: null },
            _sum: { sizeBytes: true },
          })
        : [];
      const lastDeploy = new Map(versions.map((v) => [v.workspaceId, v._max.deployedAt]));
      const bytes = new Map(storage.map((s) => [s.workspaceId, Number(s._sum.sizeBytes ?? 0)]));

      // INST-29: inactive = no deploy (and not created) within the last N days.
      const inactiveDays = positiveInt(q.inactiveDays);
      const cutoff = inactiveDays ? new Date(Date.now() - inactiveDays * DAY) : null;
      const filtered = cutoff
        ? candidates.filter((w) => (lastDeploy.get(w.id) ?? w.createdAt) < cutoff)
        : candidates;
      const sort = q.sort ?? 'created';
      const dir = q.order === 'asc' ? 1 : q.order === 'desc' ? -1 : sort === 'name' ? 1 : -1;
      const key = (w: (typeof candidates)[number]): number | string =>
        sort === 'name'
          ? w.name.toLowerCase()
          : sort === 'lastDeploy'
            ? (lastDeploy.get(w.id)?.getTime() ?? 0)
            : sort === 'storage'
              ? (bytes.get(w.id) ?? 0)
              : w.createdAt.getTime();
      filtered.sort((a, b) => {
        const [x, y] = [key(a), key(b)];
        return (x < y ? -1 : x > y ? 1 : a.id.localeCompare(b.id)) * dir;
      });

      const csv = q.format === 'csv';
      const offset = csv ? 0 : page(q.cursor);
      const slice = csv ? filtered : filtered.slice(offset, offset + PAGE);
      const rows = await systemDb.workspace.findMany({
        where: { id: { in: slice.map((w) => w.id) } },
        include: {
          organization: { select: { slug: true, plan: true } },
          WorkspaceConfig: { select: { plan: true, planExpiresAt: true, planOverrides: true } },
          _count: {
            // Joined members only: pending invitations aren't members yet.
            select: {
              RemoteModules: true,
              WorkspaceMembers: { where: { joinedAt: { not: null } } },
              ModuleVersions: true,
            },
          },
        },
      });
      const byId = new Map(rows.map((w) => [w.id, w]));
      const workspaces = slice.map((s) => {
        const w = byId.get(s.id)!;
        return {
          id: w.id,
          slug: w.slug,
          name: w.name,
          organization: w.organization?.slug ?? null,
          // PLN-01: the workspace's own plan; its organization's applies when higher.
          plan: w.WorkspaceConfig?.plan ?? 'hobby',
          organizationPlan: w.organization?.plan ?? null,
          modules: w._count.RemoteModules,
          members: w._count.WorkspaceMembers,
          deploys: w._count.ModuleVersions,
          storageBytes: bytes.get(w.id) ?? 0,
          lastDeployAt: iso(lastDeploy.get(w.id)),
          planExpiresAt: w.WorkspaceConfig?.planExpiresAt ?? null,
          planOverrides: w.WorkspaceConfig?.planOverrides ?? null,
          suspendedAt: w.suspendedAt,
          suspendedReason: w.suspendedReason,
          deletedAt: w.deletedAt,
          purgeAfter: w.purgeAfter,
          createdAt: w.createdAt,
        };
      });
      if (csv) {
        return sendCsv(
          reply,
          'workspaces',
          [
            'slug',
            'name',
            'organization',
            'plan',
            'members',
            'modules',
            'deploys',
            'storageBytes',
            'lastDeployAt',
            'status',
            'createdAt',
          ],
          workspaces.map((w) => [
            w.slug,
            w.name,
            w.organization,
            w.plan,
            w.members,
            w.modules,
            w.deploys,
            w.storageBytes,
            w.lastDeployAt,
            w.deletedAt ? 'deleted' : w.suspendedAt ? 'suspended' : 'active',
            w.createdAt.toISOString(),
          ])
        );
      }
      return {
        workspaces,
        total: filtered.length,
        nextCursor: offset + PAGE < filtered.length ? String(offset + PAGE) : null,
      };
    }
  );

  /** INST-29: everything about one workspace, for support and operations. */
  fastify.get<{ Params: { slug: string } }>(
    '/api/admin/workspaces/:slug',
    admin,
    async (request) => {
      const w = await systemDb.workspace.findUnique({
        where: { slug: request.params.slug },
        include: {
          organization: { select: { slug: true, name: true, suspendedAt: true } },
          WorkspaceConfig: true,
          WorkspaceStorageConfig: true,
          WorkspaceMembers: {
            include: { user: { select: { id: true, email: true, lastLoginAt: true } } },
            orderBy: { invitedAt: 'asc' },
          },
          HostApps: {
            include: { Environments: { orderBy: { slug: 'asc' } } },
            orderBy: { slug: 'asc' },
          },
        },
      });
      if (!w) throw new NotFoundError('Workspace not found');
      const now = new Date();
      const [keys, entitlements, usage, sso, support, audit] = await Promise.all([
        systemDb.apiKey.aggregate({
          where: {
            workspaceId: w.id,
            revokedAt: null,
            OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
          },
          _count: { _all: true },
          _max: { lastUsedAt: true },
        }),
        plans.forWorkspace({ id: w.id }),
        workspaceUsage({ plans, quotas }, systemDb, [w], 30),
        effectiveSso(systemDb, w),
        activeGrantsOn(systemDb, { workspaceId: w.id, organizationId: w.organizationId }),
        recentAudit({ workspaceId: w.id }),
      ]);
      const config = w.WorkspaceConfig;
      const storage = w.WorkspaceStorageConfig;
      return {
        id: w.id,
        slug: w.slug,
        name: w.name,
        organization: w.organization
          ? { slug: w.organization.slug, name: w.organization.name }
          : null,
        createdAt: w.createdAt.toISOString(),
        retentionDays: w.retentionDays,
        suspendedAt: iso(w.suspendedAt),
        suspendedReason: w.suspendedReason,
        deletedAt: iso(w.deletedAt),
        purgeAfter: iso(w.purgeAfter),
        plan: {
          plan: config?.plan ?? 'hobby',
          effective: entitlements.plan,
          expiresAt: iso(config?.planExpiresAt),
          basePlan: config?.basePlan ?? null,
          overrides: config?.planOverrides ?? null,
          limits: entitlements.limits,
        },
        usage: usage[0] ?? null,
        members: w.WorkspaceMembers.map((m) => ({
          userId: m.user.id,
          email: m.user.email,
          role: m.role,
          joinedAt: iso(m.joinedAt),
          lastLoginAt: iso(m.user.lastLoginAt),
        })),
        hostApps: w.HostApps.map((h) => ({
          slug: h.slug,
          name: h.name,
          environments: h.Environments.map((e) => ({
            slug: e.slug,
            name: e.name,
            lastPublishedAt: iso(e.lastPublishedAt),
            lastPublishError: e.lastPublishError,
            frozen: !!e.frozenAt,
            ephemeral: e.ephemeral,
          })),
        })),
        apiKeys: { active: keys._count._all, lastUsedAt: iso(keys._max.lastUsedAt) },
        sso: {
          own: { oidc: !!config?.oidcConfig, saml: !!config?.samlConfig },
          // The workspace's own, or its organization's (ORG-05).
          from: sso.subject ? sso.subject.kind : null,
          forceSso: sso.forceSso,
          scim: !!config?.scimEnabled,
        },
        storage: storage
          ? {
              provider: storage.provider,
              bucket: storage.bucket,
              region: storage.region,
              lastVerifiedAt: iso(storage.lastVerifiedAt),
            }
          : null,
        supportAccess: support,
        recentAudit: audit,
      };
    }
  );

  // ─── Organizations (INST-19) ──────────────────────────────────────────────

  fastify.get<{ Querystring: { query?: string; cursor?: string; status?: string } }>(
    '/api/admin/orgs',
    admin,
    async (request) => {
      const text = request.query.query?.trim();
      const status = request.query.status;
      const where: Prisma.OrganizationWhereInput = {
        ...(text && {
          OR: [
            { slug: { contains: text, mode: 'insensitive' } },
            { name: { contains: text, mode: 'insensitive' } },
          ],
        }),
        ...(status === 'active' && { deletedAt: null, suspendedAt: null }),
        ...(status === 'suspended' && { deletedAt: null, suspendedAt: { not: null } }),
        ...(status === 'deleted' && { deletedAt: { not: null } }),
      };
      const offset = page(request.query.cursor);
      // Deleted organizations too (until purged), so they can be restored.
      const [orgs, total] = await Promise.all([
        systemDb.organization.findMany({
          where,
          include: { _count: { select: { Workspaces: true, Members: true } } },
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          skip: offset,
          take: PAGE,
        }),
        systemDb.organization.count({ where }),
      ]);
      return {
        organizations: orgs.map((o) => ({
          slug: o.slug,
          name: o.name,
          plan: o.plan,
          planExpiresAt: o.planExpiresAt,
          basePlan: o.basePlan,
          planOverrides: o.planOverrides,
          workspaces: o._count.Workspaces,
          members: o._count.Members,
          suspendedAt: o.suspendedAt,
          suspendedReason: o.suspendedReason,
          deletedAt: o.deletedAt,
          purgeAfter: o.purgeAfter,
          createdAt: o.createdAt,
        })),
        total,
        nextCursor: offset + PAGE < total ? String(offset + PAGE) : null,
      };
    }
  );

  /** INST-19: an organization's workspaces, members, plan, usage, SSO and domains. */
  fastify.get<{ Params: { slug: string } }>('/api/admin/orgs/:slug', admin, async (request) => {
    const o = await systemDb.organization.findUnique({
      where: { slug: request.params.slug },
      include: {
        Members: {
          include: { user: { select: { id: true, email: true, lastLoginAt: true } } },
          orderBy: { createdAt: 'asc' },
        },
        Workspaces: {
          include: {
            _count: {
              select: {
                WorkspaceMembers: { where: { joinedAt: { not: null } } },
                RemoteModules: true,
              },
            },
          },
          orderBy: { name: 'asc' },
        },
      },
    });
    if (!o) throw new NotFoundError('Organization not found');
    const live = o.Workspaces.filter((w) => !w.deletedAt);
    const [usage, domains, support, audit, entitlements] = await Promise.all([
      workspaceUsage({ plans, quotas }, systemDb, live, 30),
      systemDb.verifiedDomain.findMany({
        where: { organizationId: o.id },
        orderBy: { domain: 'asc' },
      }),
      activeGrantsOn(systemDb, { organizationId: o.id }),
      recentAudit({ organizationId: o.id }),
      plans.forOrg(o.id),
    ]);
    return {
      id: o.id,
      slug: o.slug,
      name: o.name,
      createdAt: o.createdAt.toISOString(),
      suspendedAt: iso(o.suspendedAt),
      suspendedReason: o.suspendedReason,
      deletedAt: iso(o.deletedAt),
      purgeAfter: iso(o.purgeAfter),
      plan: {
        plan: o.plan,
        expiresAt: iso(o.planExpiresAt),
        basePlan: o.basePlan,
        overrides: o.planOverrides,
        limits: entitlements.limits,
      },
      usage: usageTotals(usage),
      members: o.Members.map((m) => ({
        userId: m.user.id,
        email: m.user.email,
        role: m.role,
        lastLoginAt: iso(m.user.lastLoginAt),
      })),
      workspaces: o.Workspaces.map((w) => ({
        slug: w.slug,
        name: w.name,
        members: w._count.WorkspaceMembers,
        modules: w._count.RemoteModules,
        suspended: !!w.suspendedAt,
        deletedAt: iso(w.deletedAt),
      })),
      sso: {
        oidc: !!o.oidcConfig,
        saml: !!o.samlConfig,
        forceSso: o.forceSso,
        scim: o.scimEnabled,
      },
      domains: domains.map((d) => ({
        domain: d.domain,
        verifiedAt: iso(d.verifiedAt),
        lastCheckedAt: iso(d.lastCheckedAt),
        failingSince: iso(d.failingSince),
      })),
      supportAccess: support,
      recentAudit: audit,
    };
  });

  /**
   * INST-19: deletes an organization (`confirm` = its slug). Like its admins' own delete:
   * only without live workspaces, its org keys are revoked, and it is restorable until
   * `purgeAfter`.
   */
  fastify.delete<{ Params: { slug: string }; Querystring: { confirm?: string } }>(
    '/api/admin/orgs/:slug',
    admin,
    async (request, reply) => {
      const org = await systemDb.organization.findFirst({
        where: { slug: request.params.slug, deletedAt: null },
      });
      if (!org) throw new NotFoundError('Organization not found');
      if (request.query.confirm !== org.slug) {
        throw new BadRequestError('Confirm with ?confirm=<organization slug>');
      }
      if (await systemDb.workspace.count({ where: { organizationId: org.id, deletedAt: null } })) {
        throw new ConflictError('Detach or delete the organization’s workspaces first');
      }
      const now = new Date();
      await systemDb.$transaction([
        systemDb.organization.update({
          where: { id: org.id },
          data: {
            deletedAt: now,
            purgeAfter: new Date(now.getTime() + fastify.config.tenantRestoreDays * DAY),
          },
        }),
        systemDb.orgApiKey.updateMany({
          where: { organizationId: org.id, revokedAt: null },
          data: { revokedAt: now },
        }),
      ]);
      await instanceAudit(request, {
        action: 'instance.org_delete',
        resourceType: 'organization',
        resourceId: org.id,
        metadata: { slug: org.slug },
      });
      return reply.code(204).send();
    }
  );

  // ─── Email log (INST-38) ──────────────────────────────────────────────────

  /** Emails of the last 30 days, newest first: recipient, template, result; no bodies. */
  fastify.get<{ Querystring: { to?: string; status?: string; cursor?: string } }>(
    '/api/admin/email/deliveries',
    admin,
    async (request) => {
      const q = request.query;
      const where: Prisma.EmailDeliveryWhereInput = {
        ...(q.to && { to: { contains: q.to.trim(), mode: 'insensitive' } }),
        ...(q.status && { status: q.status }),
      };
      const offset = page(q.cursor);
      const [rows, total] = await Promise.all([
        systemDb.emailDelivery.findMany({
          where,
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          skip: offset,
          take: PAGE,
        }),
        systemDb.emailDelivery.count({ where }),
      ]);
      return {
        deliveries: rows.map((d) => ({ ...d, createdAt: d.createdAt.toISOString() })),
        total,
        nextCursor: offset + PAGE < total ? String(offset + PAGE) : null,
      };
    }
  );

  // ─── Users (INST-10, INST-21, INST-30) ────────────────────────────────────

  type UserQuery = {
    query?: string;
    filter?: 'admins' | 'suspended' | 'never' | 'inactive';
    inactiveDays?: string;
    cursor?: string;
    format?: string;
  };

  fastify.get<{ Querystring: UserQuery }>('/api/admin/users', admin, async (request, reply) => {
    const q = request.query;
    const text = q.query?.trim();
    const now = new Date();
    const days = positiveInt(q.inactiveDays) ?? 90;
    const cutoff = new Date(now.getTime() - days * DAY);
    const where: Prisma.UserWhereInput = {
      ...(text && {
        OR: [
          { email: { contains: text, mode: 'insensitive' } },
          { name: { contains: text, mode: 'insensitive' } },
        ],
      }),
      ...(q.filter === 'admins' && { InstanceAdmin: { revokedAt: null } }),
      ...(q.filter === 'suspended' && { suspendedAt: { not: null } }),
      ...(q.filter === 'never' && { lastLoginAt: null }),
      ...(q.filter === 'inactive' && {
        AND: [
          { createdAt: { lt: cutoff } },
          { OR: [{ lastLoginAt: null }, { lastLoginAt: { lt: cutoff } }] },
        ],
      }),
    };
    const csv = q.format === 'csv';
    const offset = csv ? 0 : page(q.cursor);
    const [rows, total] = await Promise.all([
      systemDb.user.findMany({
        where,
        include: {
          WorkspaceMembers: {
            where: { joinedAt: { not: null } },
            include: { workspace: { select: { slug: true } } },
          },
          OrganizationMembers: { include: { organization: { select: { slug: true } } } },
          InstanceAdmin: true,
          _count: {
            select: { RefreshTokens: { where: { revokedAt: null, expiresAt: { gt: now } } } },
          },
        },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        ...(!csv && { skip: offset, take: PAGE }),
      }),
      systemDb.user.count({ where }),
    ]);
    const users = rows.map((u) => ({
      id: u.id,
      email: u.email,
      name: u.name,
      lastLoginAt: u.lastLoginAt,
      createdAt: u.createdAt,
      isInstanceAdmin: !!u.InstanceAdmin && !u.InstanceAdmin.revokedAt,
      activeSessions: u._count.RefreshTokens,
      mfaEnabled: !!u.mfaEnabledAt,
      suspendedAt: u.suspendedAt,
      suspendedReason: u.suspendedReason,
      workspaces: u.WorkspaceMembers.map((m) => ({ slug: m.workspace.slug, role: m.role })),
      organizations: u.OrganizationMembers.map((m) => ({
        slug: m.organization.slug,
        role: m.role,
      })),
    }));
    if (csv) {
      return sendCsv(
        reply,
        'users',
        [
          'email',
          'name',
          'createdAt',
          'lastLoginAt',
          'instanceAdmin',
          'mfa',
          'suspended',
          'organizations',
          'workspaces',
        ],
        users.map((u) => [
          u.email,
          u.name,
          u.createdAt.toISOString(),
          iso(u.lastLoginAt),
          u.isInstanceAdmin,
          u.mfaEnabled,
          !!u.suspendedAt,
          u.organizations.map((o) => `${o.slug}:${o.role}`).join(' '),
          u.workspaces.map((w) => `${w.slug}:${w.role}`).join(' '),
        ])
      );
    }
    return {
      users,
      total,
      nextCursor: offset + PAGE < total ? String(offset + PAGE) : null,
    };
  });

  const userById = async (id: string) => {
    const user = await systemDb.user.findUnique({ where: { id } });
    if (!user) throw new NotFoundError('User not found');
    return user;
  };

  /** INST-30: sign-in methods, memberships, sessions, keys and activity across tenants. */
  fastify.get<{ Params: { id: string } }>('/api/admin/users/:id', admin, async (request) => {
    const u = await systemDb.user.findUnique({
      where: { id: request.params.id },
      include: {
        Identities: { orderBy: { createdAt: 'asc' } },
        WorkspaceMembers: {
          include: { workspace: { select: { slug: true, name: true, deletedAt: true } } },
        },
        OrganizationMembers: { include: { organization: { select: { slug: true, name: true } } } },
        InstanceAdmin: true,
      },
    });
    if (!u) throw new NotFoundError('User not found');
    const [sessions, keys, orgKeys, wsEvents, orgEvents, instEvents, signIns] = await Promise.all([
      auth.listSessions(u.id),
      systemDb.apiKey.findMany({
        where: { createdBy: u.id },
        include: { workspace: { select: { slug: true } } },
        orderBy: { createdAt: 'desc' },
        take: 50,
      }),
      systemDb.orgApiKey.findMany({
        where: { createdBy: u.id },
        include: { organization: { select: { slug: true } } },
        orderBy: { createdAt: 'desc' },
        take: 50,
      }),
      systemDb.auditEvent.findMany({
        where: { actorId: u.id },
        orderBy: { createdAt: 'desc' },
        take: 30,
      }),
      systemDb.organizationAuditEvent.findMany({
        where: { actorId: u.id },
        orderBy: { createdAt: 'desc' },
        take: 30,
      }),
      systemDb.instanceAuditEvent.findMany({
        where: { actorId: u.id },
        orderBy: { createdAt: 'desc' },
        take: 30,
      }),
      systemDb.signInEvent.findMany({
        where: { OR: [{ userId: u.id }, { email: u.email }] },
        orderBy: { createdAt: 'desc' },
        take: 20,
      }),
    ]);
    const wsSlugs = new Map(
      (
        await systemDb.workspace.findMany({
          where: { id: { in: wsEvents.map((e) => e.workspaceId) } },
          select: { id: true, slug: true },
        })
      ).map((w) => [w.id, w.slug])
    );
    const orgSlugs = new Map(
      (
        await systemDb.organization.findMany({
          where: { id: { in: orgEvents.map((e) => e.organizationId) } },
          select: { id: true, slug: true },
        })
      ).map((o) => [o.id, o.slug])
    );
    const activity = [
      ...wsEvents.map((e) => ({
        scope: 'workspace' as const,
        tenant: wsSlugs.get(e.workspaceId) ?? null,
        action: e.action,
        resourceType: e.resourceType,
        resourceId: e.resourceId,
        createdAt: e.createdAt,
      })),
      ...orgEvents.map((e) => ({
        scope: 'organization' as const,
        tenant: orgSlugs.get(e.organizationId) ?? null,
        action: e.action,
        resourceType: e.resourceType,
        resourceId: e.resourceId,
        createdAt: e.createdAt,
      })),
      ...instEvents.map((e) => ({
        scope: 'instance' as const,
        tenant: null,
        action: e.action,
        resourceType: e.resourceType,
        resourceId: e.resourceId,
        createdAt: e.createdAt,
      })),
    ]
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .slice(0, 30)
      .map((e) => ({ ...e, createdAt: e.createdAt.toISOString() }));
    return {
      id: u.id,
      email: u.email,
      name: u.name,
      createdAt: u.createdAt.toISOString(),
      lastLoginAt: iso(u.lastLoginAt),
      mfaEnabled: !!u.mfaEnabledAt,
      suspendedAt: iso(u.suspendedAt),
      suspendedReason: u.suspendedReason,
      pendingEmail:
        u.pendingEmail && u.pendingEmailExpiresAt && u.pendingEmailExpiresAt > new Date()
          ? u.pendingEmail
          : null,
      instanceAdmin:
        u.InstanceAdmin && !u.InstanceAdmin.revokedAt ? { role: u.InstanceAdmin.role } : null,
      identities: u.Identities.map((i) => ({
        provider: i.provider,
        email: i.email,
        createdAt: i.createdAt.toISOString(),
        lastUsedAt: iso(i.lastUsedAt),
      })),
      workspaces: u.WorkspaceMembers.map((m) => ({
        slug: m.workspace.slug,
        name: m.workspace.name,
        role: m.role,
        joinedAt: iso(m.joinedAt),
        deleted: !!m.workspace.deletedAt,
      })),
      organizations: u.OrganizationMembers.map((m) => ({
        slug: m.organization.slug,
        name: m.organization.name,
        role: m.role,
      })),
      sessions,
      apiKeys: [
        ...keys.map((k) => ({
          id: k.id,
          scope: 'workspace' as const,
          tenant: k.workspace.slug,
          name: k.name,
          prefix: k.prefix,
          lastUsedAt: iso(k.lastUsedAt),
          revokedAt: iso(k.revokedAt),
        })),
        ...orgKeys.map((k) => ({
          id: k.id,
          scope: 'organization' as const,
          tenant: k.organization.slug,
          name: k.name,
          prefix: k.prefix,
          lastUsedAt: iso(k.lastUsedAt),
          revokedAt: iso(k.revokedAt),
        })),
      ],
      activity,
      signIns: signIns.map((s) => ({
        method: s.method,
        success: s.success,
        reason: s.reason,
        ip: s.ip,
        createdAt: s.createdAt.toISOString(),
      })),
    };
  });

  /** INST-30: ends one of a user's sessions. */
  fastify.delete<{ Params: { id: string; sessionId: string } }>(
    '/api/admin/users/:id/sessions/:sessionId',
    admin,
    async (request, reply) => {
      const user = await userById(request.params.id);
      if (!(await auth.endSession(user.id, request.params.sessionId))) {
        throw new NotFoundError('No such session');
      }
      await instanceAudit(request, {
        action: 'instance.user_session_end',
        resourceType: 'user',
        resourceId: user.id,
        metadata: { session: request.params.sessionId },
      });
      return reply.code(204).send();
    }
  );

  /**
   * INST-30: changes a user's email once the new address confirms it: a link valid for
   * 24 hours goes to the new address; the account keeps the old one until then.
   */
  fastify.post<{ Params: { id: string } }>(
    '/api/admin/users/:id/email',
    admin,
    async (request, reply) => {
      const { email } = z
        .object({ email: z.string().trim().toLowerCase().email().max(320) })
        .parse(request.body);
      const user = await userById(request.params.id);
      if (email === user.email) throw new BadRequestError('That is already their email');
      if (await systemDb.user.findUnique({ where: { email } })) {
        throw new ConflictError('Another account uses this email; merge the accounts instead');
      }
      const mailer = fastify.container.mailer;
      if (!mailer) throw new BadRequestError('No email is configured to send the confirmation');
      const token = randomBytes(32).toString('base64url');
      const expiresAt = new Date(Date.now() + DAY);
      await systemDb.user.update({
        where: { id: user.id },
        data: {
          pendingEmail: email,
          pendingEmailTokenHash: sha256(token),
          pendingEmailExpiresAt: expiresAt,
        },
      });
      const name = fastify.container.settings.branding().name;
      const link = new URL('/auth/email-change', fastify.config.webOrigin);
      link.searchParams.set('token', token);
      await mailer.send({
        template: 'email_change',
        to: email,
        subject: `${name}: confirm your new email address`,
        text: [
          `An administrator of ${name} is changing the email of your account from ${user.email} to ${email}.`,
          '',
          `Confirm it within 24 hours: ${link.toString()}`,
          '',
          'If you did not expect this, ignore this email; nothing changes.',
        ].join('\n'),
      });
      await instanceAudit(request, {
        action: 'instance.user_email_change',
        resourceType: 'user',
        resourceId: user.id,
        metadata: { from: user.email, to: email },
      });
      return reply.code(202).send({ pendingEmail: email, expiresAt: expiresAt.toISOString() });
    }
  );

  /** The new address confirms the change (public: the token is the proof). */
  fastify.post(
    '/api/auth/email-change',
    { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } },
    async (request) => {
      const { token } = z.object({ token: z.string().min(20).max(200) }).parse(request.body);
      const user = await systemDb.user.findUnique({
        where: { pendingEmailTokenHash: sha256(token) },
      });
      if (
        !user?.pendingEmail ||
        !user.pendingEmailExpiresAt ||
        user.pendingEmailExpiresAt < new Date()
      ) {
        throw new BadRequestError('This link is invalid or has expired');
      }
      const email = user.pendingEmail;
      if (await systemDb.user.findUnique({ where: { email } })) {
        throw new ConflictError('Another account took this email in the meantime');
      }
      await systemDb.$transaction(async (tx) => {
        await tx.user.update({
          where: { id: user.id },
          data: {
            email,
            pendingEmail: null,
            pendingEmailTokenHash: null,
            pendingEmailExpiresAt: null,
          },
        });
        // Email sign-in is keyed by the address.
        await tx.identity.updateMany({
          where: { userId: user.id, provider: 'email' },
          data: { providerUserId: email, email },
        });
        await tx.instanceAuditEvent.create({
          data: {
            actorType: 'user',
            actorId: user.id,
            ip: request.ip,
            action: 'user.email_changed',
            resourceType: 'user',
            resourceId: user.id,
            metadata: { from: user.email, to: email },
          },
        });
      });
      return { email };
    }
  );

  /**
   * INST-30: merges the account `:id` into `into` (the one that stays): sign-in methods,
   * memberships (the higher role wins), API keys it created. Its sessions end and the
   * account is removed. Instance admins are not merged (revoke the grant first).
   */
  fastify.post<{ Params: { id: string } }>('/api/admin/users/:id/merge', admin, async (request) => {
    const { into } = z.object({ into: z.string().min(1) }).parse(request.body);
    const from = await userById(request.params.id);
    const target = await userById(into);
    if (from.id === target.id) throw new BadRequestError('An account cannot merge into itself');
    const grant = await systemDb.instanceAdmin.findFirst({
      where: { userId: from.id, revokedAt: null },
    });
    if (grant) throw new ConflictError('Revoke their instance admin role before merging');

    const moved = await systemDb.$transaction(async (tx) => {
      const identities = await tx.identity.updateMany({
        where: { userId: from.id },
        data: { userId: target.id },
      });
      let workspaces = 0;
      for (const m of await tx.workspaceMember.findMany({ where: { userId: from.id } })) {
        const existing = await tx.workspaceMember.findUnique({
          where: { workspaceId_userId: { workspaceId: m.workspaceId, userId: target.id } },
        });
        if (!existing) {
          await tx.workspaceMember.update({ where: { id: m.id }, data: { userId: target.id } });
        } else {
          if (WS_RANK[m.role] > WS_RANK[existing.role] || (!existing.joinedAt && m.joinedAt)) {
            await tx.workspaceMember.update({
              where: { id: existing.id },
              data: {
                role: WS_RANK[m.role] > WS_RANK[existing.role] ? m.role : existing.role,
                joinedAt: existing.joinedAt ?? m.joinedAt,
              },
            });
          }
          // Module ownerships follow the membership that stays.
          for (const o of await tx.moduleOwnership.findMany({
            where: { workspaceMemberId: m.id },
          })) {
            const kept = await tx.moduleOwnership.findFirst({
              where: { remoteModuleId: o.remoteModuleId, workspaceMemberId: existing.id },
            });
            if (!kept) {
              await tx.moduleOwnership.update({
                where: { id: o.id },
                data: { workspaceMemberId: existing.id },
              });
            }
          }
          await tx.workspaceMember.delete({ where: { id: m.id } });
        }
        workspaces++;
      }
      let organizations = 0;
      for (const m of await tx.organizationMember.findMany({ where: { userId: from.id } })) {
        const existing = await tx.organizationMember.findUnique({
          where: {
            organizationId_userId: { organizationId: m.organizationId, userId: target.id },
          },
        });
        if (!existing) {
          await tx.organizationMember.update({ where: { id: m.id }, data: { userId: target.id } });
        } else {
          if ((ORG_RANK[m.role] ?? 0) > (ORG_RANK[existing.role] ?? 0)) {
            await tx.organizationMember.update({
              where: { id: existing.id },
              data: { role: m.role },
            });
          }
          await tx.organizationMember.delete({ where: { id: m.id } });
        }
        organizations++;
      }
      const keys = await tx.apiKey.updateMany({
        where: { createdBy: from.id },
        data: { createdBy: target.id },
      });
      await tx.orgApiKey.updateMany({
        where: { createdBy: from.id },
        data: { createdBy: target.id },
      });
      // SCIM links stay with the IdP's record; a duplicate for the same tenant is dropped.
      for (const s of await tx.scimUser.findMany({ where: { userId: from.id } })) {
        const clash = await tx.scimUser.findFirst({
          where: {
            userId: target.id,
            ...(s.workspaceId ? { workspaceId: s.workspaceId } : {}),
            ...(s.organizationId ? { organizationId: s.organizationId } : {}),
          },
        });
        if (clash) await tx.scimUser.delete({ where: { id: s.id } });
        else await tx.scimUser.update({ where: { id: s.id }, data: { userId: target.id } });
      }
      await tx.user.delete({ where: { id: from.id } });
      return {
        identities: identities.count,
        workspaces,
        organizations,
        apiKeys: keys.count,
      };
    });
    await instanceAudit(request, {
      action: 'instance.user_merge',
      resourceType: 'user',
      resourceId: target.id,
      metadata: { from: from.email, fromId: from.id, into: target.email, ...moved },
    });
    return { id: target.id, email: target.email, moved };
  });
};

export default adminDirectoryRoutes;
