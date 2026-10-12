// Copyright The Harmoniq Authors
// SPDX-License-Identifier: Apache-2.0

import { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { Prisma } from '@prisma/client';
import type { Invitation } from '@prisma/client';
import { z } from 'zod';
import type { TenantTx } from '@harmoniq/db';
import type { OrgApiKey, Organization } from '@prisma/client';
import {
  BadRequestError,
  ConflictError,
  ForbiddenError,
  NotFoundError,
} from '@harmoniq/core/dist/errors/AppError';
import {
  AddOrgMemberSchema,
  CreateOrgApiKeySchema,
  CreateOrganizationSchema,
  CreateOrgWorkspaceSchema,
  OrgRole,
  UpdateOrgMemberSchema,
  UpdateOrganizationSchema,
} from '@harmoniq/core/dist/schemas/ResourceSchemas';
import { formatOrgApiKey, generateApiKeySecret } from '../auth/apiKeys';
import { ssoScope } from '../plugins/authenticate';
import { audit } from '../services/audit';
import { verifyChain } from '../services/auditChain';
import { actorOf, actorWhere, parseDate, resolveActors } from '../services/auditActors';
import { invalidateManifest } from '../services/cacheKeys';
import { createWorkspace } from '../services/workspaces';
import { assertMayCreateTenant } from '../services/tenancyPolicy';
import { softDeleteWorkspace } from '../services/tenantLifecycle';
import { offboardOrgMember } from '../services/orgProvisioning';
import { ssoProviderIds } from '../services/ssoIds';
import { isFrozen } from '../services/manifestMutation';
import {
  ExportRow,
  NEWEST_FIRST,
  afterWhere,
  dateRange,
  exportFormat,
  keysetRows,
  mergeNewestFirst,
  sendExport,
} from '../services/auditExport';
import { orgSsoRoutes } from './orgSso';
import { orgDomainRoutes } from './domains';
import { orgPolicyRoutes } from './policy';
import { orgEventRoutes } from './orgEvents';
import { orgAuditSinkRoutes } from './auditSinks';
import type { OrgEventName } from '@harmoniq/core/dist/schemas/OrgEventsSchema';
import {
  assertKeyPolicy,
  cappedExpiry,
  keyPolicyViolations,
  orgPolicyFor,
} from '../services/policy';
import { proposeTransfer, transferDto } from './transfers';
import {
  acceptUrl,
  createInvitation,
  invitationDto,
  renewInvitation,
  sendInvitationEmail,
} from '../services/invitations';
import { organizationRecords, sendTenantExport } from '../services/tenantExport';
import { reportDays, sendUsageCsv, usageTotals, workspaceUsage } from '../services/usageReport';

declare module 'fastify' {
  interface FastifyRequest {
    /** Set by `requireOrg`. */
    org?: Organization;
    /** The caller's role in `org` (undefined for instance admins without one). */
    orgRole?: OrgRole;
    /** TAD-09/10: org audit events of this request, sent as org events once it succeeds. */
    orgEvents?: Array<{ action: string; resourceId: string; metadata?: Record<string, unknown> }>;
  }
}

type OrgParams = { orgSlug: string };
type OrgWsParams = OrgParams & { workspaceSlug: string };

// ORG-01..15: organizations group workspaces. Org admins manage the org, its members,
// keys and workspaces, and administer every workspace in it; org members see the org.
const RotateOrgKeySchema = z.object({
  gracePeriodHours: z
    .number()
    .int()
    .min(0)
    .max(24 * 30)
    .default(24),
});

/** TAD-09/10: org audit actions that are also organization events. */
const ORG_EVENTS: Record<string, OrgEventName> = {
  'org.member_add': 'org.member.added',
  'org.member_role_change': 'org.member.role_changed',
  'org.member_remove': 'org.member.removed',
  'org.workspace_create': 'org.workspace.created',
  'org.workspace_attach': 'org.workspace.attached',
  'org.workspace_delete': 'org.workspace.deleted',
  'org.workspace_detach': 'org.workspace.detached',
  'org.key_create': 'org.key.created',
  'org.key_rotate': 'org.key.rotated',
  'org.key_revoke': 'org.key.revoked',
  'org.policy_updated': 'org.policy.updated',
};

/** TAD-05: keys not used for this long are flagged in the list. */
const UNUSED_KEY_DAYS = 90;

function orgKeyStatus(k: OrgApiKey, now = Date.now()) {
  if (k.revokedAt) return 'revoked';
  if (k.expiresAt && k.expiresAt.getTime() <= now) return 'expired';
  if (k.gracePeriodEnd) return k.gracePeriodEnd.getTime() <= now ? 'expired' : 'rotating';
  return 'active';
}

function orgKeyDto(k: OrgApiKey) {
  const now = Date.now();
  const status = orgKeyStatus(k, now);
  const lastActive = (k.lastUsedAt ?? k.createdAt).getTime();
  return {
    id: k.id,
    name: k.name,
    prefix: k.prefix,
    status,
    scopes: k.scopes,
    moduleIds: k.moduleScope,
    expiresAt: k.expiresAt?.toISOString() ?? null,
    gracePeriodEnd: k.gracePeriodEnd?.toISOString() ?? null,
    lastUsedAt: k.lastUsedAt?.toISOString() ?? null,
    unused: status === 'active' && now - lastActive > UNUSED_KEY_DAYS * 86_400_000,
    revokedAt: k.revokedAt?.toISOString() ?? null,
    createdAt: k.createdAt.toISOString(),
  };
}

const orgRoutes: FastifyPluginAsync = async (fastify) => {
  // eslint-disable-next-line no-restricted-syntax -- MT-09: tenant resolution and creation only (marked below)
  const { systemDb, cache, orgShared, withOrg, withTenant } = fastify.container;
  /** MT-07/08: the request's organization, its rows and its workspaces' (RLS). */
  const inOrg = <T>(request: FastifyRequest, fn: (tx: TenantTx) => Promise<T>) =>
    withOrg(request.org!.id, fn);

  /** TLC-04: a suspended organization stays readable but refuses every change. */
  const orgSuspended = (request: FastifyRequest, org: Organization) =>
    !!org.suspendedAt && request.method !== 'GET';
  const refuseSuspended = (reply: FastifyReply) =>
    reply.code(403).send({
      error: {
        code: 'ORGANIZATION_SUSPENDED',
        message:
          'This organization is suspended by the instance administrator; changes are disabled',
      },
    });

  const refuseIp = (reply: FastifyReply, ip: string) =>
    reply.code(403).send({
      error: {
        code: 'IP_NOT_ALLOWED',
        message: `Access from ${ip} is not allowed by the organization`,
      },
    });

  /**
   * `member`: any org role; `admin`: org_admin; `auditor`: org_admin or org_auditor (PPL-08:
   * read-only access to the audit log, settings and people).
   */
  function requireOrg(
    level: 'member' | 'admin' | 'auditor' | 'billing',
    opts: { allowOrgKey?: boolean } = {}
  ) {
    return async (request: FastifyRequest, reply: FastifyReply) => {
      await fastify.authenticate(request, reply);
      if (reply.sent) return;
      const principal = request.principal!;
      // IaC-01: Terraform and other automation manage the org's workspaces with an org key
      // that has the `admin` scope and isn't limited to some workspaces.
      if (opts.allowOrgKey && principal.type === 'apiKey' && principal.organizationId) {
        // eslint-disable-next-line no-restricted-syntax -- MT-09: tenant resolution (org key)
        const org = await systemDb.organization.findFirst({
          where: { slug: (request.params as OrgParams).orgSlug, deletedAt: null },
        });
        if (!org || org.id !== principal.organizationId) {
          return reply.code(403).send({
            error: { code: 'FORBIDDEN', message: 'API key is not valid for this organization' },
          });
        }
        if (!principal.scopes.includes('admin') || principal.workspaceIds?.length) {
          return reply.code(403).send({
            error: {
              code: 'FORBIDDEN',
              message:
                'Managing workspaces needs an org key with the admin scope for all workspaces',
            },
          });
        }
        if (orgSuspended(request, org)) return refuseSuspended(reply);
        if (!(await fastify.ipAllowedForOrg(org.id, request.ip, 'management'))) {
          return refuseIp(reply, request.ip);
        }
        request.org = org;
        return;
      }
      if (principal.type !== 'user') {
        return reply
          .code(403)
          .send({ error: { code: 'FORBIDDEN', message: 'Organizations are managed by users' } });
      }
      // A workspace-SSO session stays in its workspace; an org-SSO session in its org.
      const { orgSlug } = request.params as OrgParams;
      const scope = ssoScope(principal);
      if (scope && !(scope.kind === 'organization' && scope.slug === orgSlug)) {
        return reply.code(403).send({
          error: {
            code: 'SSO_SCOPED',
            message: `This session is limited to the single sign-on ${scope.kind} "${scope.slug}"`,
          },
        });
      }
      // eslint-disable-next-line no-restricted-syntax -- MT-09: tenant resolution
      const org = await systemDb.organization.findFirst({
        where: { slug: orgSlug, deletedAt: null },
      });
      const membership = org
        ? // eslint-disable-next-line no-restricted-syntax -- MT-09: tenant resolution
          await systemDb.organizationMember.findUnique({
            where: { organizationId_userId: { organizationId: org.id, userId: principal.id } },
          })
        : null;
      // Non-members get 404 so organization slugs can't be probed.
      if (!org || (!membership && !(principal.isInstanceAdmin && !scope))) {
        return reply
          .code(404)
          .send({ error: { code: 'NOT_FOUND', message: 'Organization not found' } });
      }
      const role = membership?.role as OrgRole | undefined;
      if (level === 'auditor' && role !== 'org_admin' && role !== 'org_auditor') {
        return reply.code(403).send({
          error: { code: 'FORBIDDEN', message: 'Requires an organization admin or auditor' },
        });
      }
      // PPL-08: plan and usage are read by billing members, auditors and admins.
      if (
        level === 'billing' &&
        role !== 'org_admin' &&
        role !== 'org_billing' &&
        role !== 'org_auditor'
      ) {
        return reply.code(403).send({
          error: {
            code: 'FORBIDDEN',
            message: 'Requires an organization admin, billing or auditor',
          },
        });
      }
      if (level === 'admin' && role !== 'org_admin') {
        return reply
          .code(403)
          .send({ error: { code: 'FORBIDDEN', message: 'Requires an organization admin' } });
      }
      if (orgSuspended(request, org)) return refuseSuspended(reply);
      // POL-08: members only from allowed networks (instance admins without a role are not
      // the organization's to restrict).
      if (role && !(await fastify.ipAllowedForOrg(org.id, request.ip, 'management'))) {
        return refuseIp(reply, request.ip);
      }
      // SES-03: members who signed in without SSO need a second factor.
      if (role && (await fastify.mfaRequiredBy(org.id, principal))) {
        return reply.code(403).send({
          error: {
            code: 'MFA_REQUIRED',
            message:
              'The organization requires multi-factor authentication: set it up in your account, then sign in again',
          },
        });
      }
      request.org = org;
      request.orgRole = role;
    };
  }
  /* eslint-disable no-restricted-syntax -- MT-09: after the response, names and emails for the events (read-only lookups) */
  // TAD-09/10: a successful request's org events go to webhooks and notification channels
  // (a failed one may have rolled back what its audit events describe).
  fastify.addHook('onResponse', async (request, reply) => {
    const pending = request.orgEvents;
    if (!pending?.length || !request.org || reply.statusCode >= 400) return;
    const orgId = request.org.id;
    for (const e of pending) {
      const name = ORG_EVENTS[e.action];
      const m = e.metadata ?? {};
      let payload: Record<string, unknown>;
      if (name.startsWith('org.member.')) {
        const member = await systemDb.organizationMember.findUnique({
          where: { id: e.resourceId },
          select: { user: { select: { email: true } } },
        });
        const user =
          member?.user ??
          (typeof m.userId === 'string'
            ? await systemDb.user.findUnique({ where: { id: m.userId }, select: { email: true } })
            : null);
        payload = {
          email: m.email ?? user?.email ?? null,
          role: m.role ?? m.to ?? null,
          ...(m.from !== undefined && { from: m.from }),
        };
      } else if (name.startsWith('org.workspace.')) {
        payload = { workspace: m.slug ?? null, workspaceId: e.resourceId };
      } else if (name.startsWith('org.key.')) {
        const key = m.name
          ? null
          : await systemDb.orgApiKey.findUnique({ where: { id: e.resourceId } });
        payload = { keyId: e.resourceId, name: m.name ?? key?.name ?? null };
      } else {
        payload = { fields: Object.keys((m.changes as object) ?? {}) };
      }
      await fastify.container.orgEvents.emit(orgId, name, payload);
    }
  });
  /* eslint-enable no-restricted-syntax */

  const member = { preHandler: requireOrg('member') };
  const admin = { preHandler: requireOrg('admin') };
  const adminOrOrgKey = { preHandler: requireOrg('admin', { allowOrgKey: true }) };
  const auditor = { preHandler: requireOrg('auditor') };
  const billing = { preHandler: requireOrg('billing') };

  /** An org audit event, in the given org transaction or in its own. */
  const orgAudit = (
    request: FastifyRequest,
    event: {
      action: string;
      resourceType: string;
      resourceId: string;
      metadata?: Record<string, unknown>;
    },
    tx?: TenantTx
  ) => {
    if (ORG_EVENTS[event.action]) {
      (request.orgEvents ??= []).push({
        action: event.action,
        resourceId: event.resourceId,
        metadata: event.metadata,
      });
    }
    const write = (db: TenantTx) =>
      db.organizationAuditEvent.create({
        data: {
          organizationId: request.org!.id,
          actorType: request.principal!.type === 'apiKey' ? 'apiKey' : 'user',
          actorId: request.principal!.id,
          ip: request.ip,
          ...event,
          metadata: event.metadata as Prisma.InputJsonValue | undefined,
        },
      });
    return tx ? write(tx) : inOrg(request, write);
  };

  const workspaceIn = async (request: FastifyRequest, slug: string) => {
    const workspace = await inOrg(request, (tx) =>
      tx.workspace.findFirst({ where: { slug, organizationId: request.org!.id, deletedAt: null } })
    );
    if (!workspace) throw new NotFoundError('Workspace not found in this organization');
    return workspace;
  };

  // ─── Organizations ────────────────────────────────────────────────────────

  fastify.post('/api/orgs', { preHandler: fastify.authenticate }, async (request, reply) => {
    const principal = request.principal!;
    if (principal.type !== 'user' || ssoScope(principal)) {
      throw new ForbiddenError('Organizations are created by users signed in directly');
    }
    const body = CreateOrganizationSchema.parse(request.body);
    await assertMayCreateTenant(fastify.container, principal, 'organization');
    try {
      // The organization doesn't exist yet, so there is no org scope to create it in.
      // eslint-disable-next-line no-restricted-syntax -- MT-09: creates a new tenant
      const org = await systemDb.$transaction(async (tx) => {
        const org = await tx.organization.create({ data: body });
        await tx.organizationMember.create({
          data: { organizationId: org.id, userId: principal.id, role: 'org_admin' },
        });
        await tx.organizationAuditEvent.create({
          data: {
            organizationId: org.id,
            actorType: 'user',
            actorId: principal.id,
            action: 'org.create',
            resourceType: 'organization',
            resourceId: org.id,
            ip: request.ip,
          },
        });
        return org;
      });
      return reply.code(201).send({ slug: org.slug, name: org.name });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        throw new ConflictError(`Organization slug "${body.slug}" is taken`);
      }
      throw err;
    }
  });

  fastify.get('/api/orgs', { preHandler: fastify.authenticate }, async (request) => {
    const principal = request.principal!;
    const scope = ssoScope(principal);
    if (principal.type !== 'user' || scope?.kind === 'workspace') return { organizations: [] };
    // eslint-disable-next-line no-restricted-syntax -- MT-09: the user's own memberships across organizations
    const memberships = await systemDb.organizationMember.findMany({
      where: {
        userId: principal.id,
        organization: { deletedAt: null, ...(scope && { slug: scope.slug }) },
      },
      include: { organization: true },
      orderBy: { organization: { name: 'asc' } },
    });
    return {
      organizations: memberships.map((m) => ({
        slug: m.organization.slug,
        name: m.organization.name,
        role: m.role,
      })),
    };
  });

  /**
   * ORG-14, TAD-06: the organization home: workspaces with activity, 24 h health, status
   * (suspended, deleted, frozen environments, pending approvals). `query` matches name or
   * slug; paginated by `cursor` (a workspace id) and `limit`.
   */
  fastify.get<{
    Params: OrgParams;
    Querystring: { query?: string; cursor?: string; limit?: string };
  }>('/api/orgs/:orgSlug', member, async (request) => {
    const org = request.org!;
    const q = request.query;
    const limit = Math.min(200, Math.max(1, Number(q.limit) || 50));
    const since = new Date(Date.now() - 24 * 3_600_000);
    const now = new Date();
    const data = await inOrg(request, async (tx) => {
      const where: Prisma.WorkspaceWhereInput = {
        organizationId: org.id,
        ...(q.query && {
          OR: [
            { name: { contains: q.query, mode: 'insensitive' } },
            { slug: { contains: q.query, mode: 'insensitive' } },
          ],
        }),
      };
      const [rows, total] = await Promise.all([
        tx.workspace.findMany({
          where,
          orderBy: [{ name: 'asc' }, { id: 'asc' }],
          take: limit + 1,
          ...(q.cursor && { cursor: { id: q.cursor }, skip: 1 }),
          include: {
            _count: {
              // Joined members only: pending invitations aren't members yet.
              select: {
                WorkspaceMembers: { where: { joinedAt: { not: null } } },
                RemoteModules: true,
              },
            },
          },
        }),
        tx.workspace.count({ where }),
      ]);
      const workspaces = rows.slice(0, limit);
      const ids = workspaces.map((w) => w.id);
      const lastDeploys = await tx.moduleVersion.groupBy({
        by: ['workspaceId'],
        where: { workspaceId: { in: ids } },
        _max: { deployedAt: true },
      });
      const health = await tx.moduleHealthRollup.groupBy({
        by: ['workspaceId'],
        where: { workspaceId: { in: ids }, hour: { gte: since } },
        _sum: { sampleCount: true, errorCount: true },
      });
      const frozen = await tx.environment.findMany({
        where: { hostApp: { workspaceId: { in: ids } }, frozenAt: { not: null } },
        select: {
          slug: true,
          frozenAt: true,
          freezeFrom: true,
          freezeUntil: true,
          hostApp: { select: { workspaceId: true, slug: true } },
        },
      });
      // Across the organization, not only this page.
      const orgWorkspaces = { workspace: { organizationId: org.id, deletedAt: null } };
      const pendingWhere = {
        ...orgWorkspaces,
        status: 'pending_approval',
        expiresAt: { gt: now },
      };
      const [pending, pendingCount] = await Promise.all([
        tx.deploymentRequest.findMany({
          where: pendingWhere,
          orderBy: { createdAt: 'desc' },
          take: 10,
          include: { workspace: { select: { slug: true } } },
        }),
        tx.deploymentRequest.groupBy({ by: ['workspaceId'], where: pendingWhere, _count: true }),
      ]);
      const recent = await tx.moduleVersion.findMany({
        where: orgWorkspaces,
        orderBy: { deployedAt: 'desc' },
        take: 10,
        include: {
          remoteModule: { select: { slug: true } },
          environment: { select: { slug: true } },
          workspace: { select: { slug: true } },
        },
      });
      // PPL-07: what the caller has in each workspace, so the dashboard can offer requests.
      const principalId = request.principal!.id;
      const mine = await tx.workspaceMember.findMany({
        where: { userId: principalId, workspaceId: { in: ids }, joinedAt: { not: null } },
        select: { workspaceId: true, role: true },
      });
      const requested = await tx.accessRequest.findMany({
        where: { userId: principalId, workspaceId: { in: ids }, status: 'pending' },
        select: { workspaceId: true },
      });
      return {
        workspaces,
        more: rows.length > limit,
        total,
        lastDeploys,
        health,
        frozen,
        pending,
        pendingCount,
        recent,
        mine,
        requested,
      };
    });
    const lastDeploy = new Map(data.lastDeploys.map((d) => [d.workspaceId, d._max.deployedAt]));
    const healthOf = new Map(data.health.map((h) => [h.workspaceId, h._sum]));
    const pendingOf = new Map(data.pendingCount.map((p) => [p.workspaceId, p._count]));
    const frozenOf = (workspaceId: string) =>
      data.frozen
        .filter((e) => e.hostApp.workspaceId === workspaceId && isFrozen(e, now))
        .map((e) => `${e.hostApp.slug}/${e.slug}`);
    return {
      slug: org.slug,
      name: org.name,
      plan: org.plan,
      role: request.orgRole ?? null,
      suspended: !!org.suspendedAt,
      total: data.total,
      nextCursor: data.more ? data.workspaces[data.workspaces.length - 1].id : null,
      workspaces: data.workspaces.map((w) => {
        const h = healthOf.get(w.id);
        return {
          id: w.id,
          slug: w.slug,
          name: w.name,
          members: w._count.WorkspaceMembers,
          modules: w._count.RemoteModules,
          lastDeployAt: lastDeploy.get(w.id)?.toISOString() ?? null,
          yourRole:
            data.mine.find((m) => m.workspaceId === w.id)?.role ??
            (request.orgRole === 'org_admin' ? 'admin' : null),
          accessRequested: data.requested.some((r) => r.workspaceId === w.id),
          // TLC-02: deleted workspaces stay listed (restorable) until the purge.
          deletedAt: w.deletedAt?.toISOString() ?? null,
          purgeAfter: w.purgeAfter?.toISOString() ?? null,
          suspended: !!w.suspendedAt,
          frozenEnvironments: frozenOf(w.id),
          pendingApprovals: pendingOf.get(w.id) ?? 0,
          health: h?.sampleCount
            ? { samples: h.sampleCount, errorRate: (h.errorCount ?? 0) / h.sampleCount }
            : null,
        };
      }),
      pendingApprovals: data.pending.map((r) => ({
        id: r.id,
        workspace: r.workspace.slug,
        type: r.type,
        requiredApprovers: r.requiredApprovers,
        expiresAt: r.expiresAt.toISOString(),
        createdAt: r.createdAt.toISOString(),
      })),
      recentDeploys: data.recent.map((v) => ({
        workspace: v.workspace.slug,
        module: v.remoteModule.slug,
        environment: v.environment.slug,
        version: v.version,
        status: v.status,
        deployedAt: v.deployedAt.toISOString(),
        deployedBy: v.deployedBy,
      })),
    };
  });

  fastify.patch<{ Params: OrgParams }>('/api/orgs/:orgSlug', admin, async (request) => {
    const body = UpdateOrganizationSchema.parse(request.body);
    const org = await inOrg(request, async (tx) => {
      const org = await tx.organization.update({ where: { id: request.org!.id }, data: body });
      await orgAudit(
        request,
        { action: 'org.update', resourceType: 'organization', resourceId: org.id, metadata: body },
        tx
      );
      return org;
    });
    return { slug: org.slug, name: org.name };
  });

  // Only an empty organization can be deleted (workspaces are detached or deleted first).
  fastify.delete<{ Params: OrgParams }>('/api/orgs/:orgSlug', admin, async (request, reply) => {
    const org = request.org!;
    await inOrg(request, async (tx) => {
      // Deleted workspaces don't count: they leave the organization when purged.
      if (await tx.workspace.count({ where: { organizationId: org.id, deletedAt: null } })) {
        throw new ConflictError('Detach or delete the organization’s workspaces first');
      }
      // TLC-02: an instance admin can restore it until `purgeAfter`; then it is purged.
      const now = new Date();
      await tx.organization.update({
        where: { id: org.id },
        data: {
          deletedAt: now,
          purgeAfter: new Date(now.getTime() + fastify.config.tenantRestoreDays * 86_400_000),
        },
      });
      await tx.orgApiKey.updateMany({
        where: { organizationId: org.id, revokedAt: null },
        data: { revokedAt: new Date() },
      });
      await orgAudit(
        request,
        { action: 'org.delete', resourceType: 'organization', resourceId: org.id },
        tx
      );
    });
    return reply.code(204).send();
  });

  // ─── Members (ORG-04/08) ──────────────────────────────────────────────────

  fastify.get<{ Params: OrgParams }>('/api/orgs/:orgSlug/members', member, async (request) => {
    const members = await inOrg(request, (tx) =>
      tx.organizationMember.findMany({
        where: { organizationId: request.org!.id },
        include: { user: { select: { id: true, email: true, name: true, avatarUrl: true } } },
        orderBy: { createdAt: 'asc' },
      })
    );
    return {
      members: members.map((m) => ({
        id: m.id,
        role: m.role,
        createdAt: m.createdAt.toISOString(),
        user: m.user,
      })),
    };
  });

  fastify.post<{ Params: OrgParams }>(
    '/api/orgs/:orgSlug/members',
    admin,
    async (request, reply) => {
      const body = AddOrgMemberSchema.parse(request.body);
      const org = request.org!;
      const email = body.email.trim().toLowerCase();
      try {
        const created = await inOrg(request, async (tx) => {
          // As with workspace invitations: their first sign-in with this email links to it.
          const user =
            (await tx.user.findFirst({
              where: { email: { equals: email, mode: 'insensitive' } },
            })) ?? (await tx.user.create({ data: { email } }));
          const created = await tx.organizationMember.create({
            data: { organizationId: org.id, userId: user.id, role: body.role },
          });
          await orgAudit(
            request,
            {
              action: 'org.member_add',
              resourceType: 'org_member',
              resourceId: created.id,
              metadata: { email, role: body.role },
            },
            tx
          );
          return created;
        });
        return reply.code(201).send({ id: created.id, email, role: created.role });
      } catch (err) {
        if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
          throw new ConflictError(`${email} is already a member`);
        }
        throw err;
      }
    }
  );

  const adminCount = (tx: TenantTx, organizationId: string) =>
    tx.organizationMember.count({ where: { organizationId, role: 'org_admin' } });

  const findMember = async (tx: TenantTx, request: FastifyRequest, id: string) => {
    const found = await tx.organizationMember.findFirst({
      where: { id, organizationId: request.org!.id },
    });
    if (!found) throw new NotFoundError('Member not found');
    return found;
  };

  fastify.patch<{ Params: OrgParams & { memberId: string } }>(
    '/api/orgs/:orgSlug/members/:memberId',
    admin,
    async (request) => {
      const { role } = UpdateOrgMemberSchema.parse(request.body);
      const updated = await inOrg(request, async (tx) => {
        const current = await findMember(tx, request, request.params.memberId);
        if (current.role === 'org_admin' && role !== 'org_admin') {
          if ((await adminCount(tx, request.org!.id)) <= 1) {
            throw new ConflictError('An organization must keep at least one admin');
          }
        }
        const updated = await tx.organizationMember.update({
          where: { id: current.id },
          data: { role },
        });
        await orgAudit(
          request,
          {
            action: 'org.member_role_change',
            resourceType: 'org_member',
            resourceId: current.id,
            metadata: { from: current.role, to: role },
          },
          tx
        );
        return updated;
      });
      return { id: updated.id, role: updated.role };
    }
  );

  /**
   * PPL-04: leaving the organization means leaving its workspaces too, with the API keys
   * the member created there (`?keepKeys=true` keeps the keys) and their org-SSO sessions.
   * Each workspace's last owner is kept. The response says what was removed.
   */
  fastify.delete<{ Params: OrgParams & { memberId: string }; Querystring: { keepKeys?: string } }>(
    '/api/orgs/:orgSlug/members/:memberId',
    admin,
    async (request) => {
      const org = request.org!;
      const revokeKeys = request.query.keepKeys !== 'true';
      const { current, result } = await inOrg(request, async (tx) => {
        const current = await findMember(tx, request, request.params.memberId);
        if (current.role === 'org_admin' && (await adminCount(tx, org.id)) <= 1) {
          throw new ConflictError('An organization must keep at least one admin');
        }
        const result = await offboardOrgMember(tx, org, current, {
          revokeKeys,
          actor: { principal: request.principal!, ip: request.ip },
        });
        return { current, result };
      });
      // Sessions are system rows (the tenant role has no access): ended after the commit,
      // like SCIM deprovisioning.
      // eslint-disable-next-line no-restricted-syntax -- MT-09: sessions are system tables
      const sessions = await systemDb.refreshToken.updateMany({
        where: {
          userId: current.userId,
          provider: { in: ssoProviderIds({ kind: 'organization', slug: org.slug }) },
          revokedAt: null,
        },
        data: { revokedAt: new Date() },
      });
      await orgAudit(request, {
        action: 'org.member_remove',
        resourceType: 'org_member',
        resourceId: current.id,
        metadata: {
          userId: current.userId,
          role: current.role,
          ...result,
          ssoSessionsEnded: sessions.count,
        },
      });
      return { ...result, ssoSessionsEnded: sessions.count };
    }
  );

  /**
   * TLC-06: an org admin hands the admin seat to an org member, who accepts it at
   * `POST /api/transfers/:id/accept`; the sender then becomes an org_member.
   */
  fastify.post<{ Params: OrgParams }>(
    '/api/orgs/:orgSlug/transfer',
    admin,
    async (request, reply) => {
      const { email } = z
        .object({ email: z.string().trim().toLowerCase().email() })
        .parse(request.body);
      const principal = request.principal!;
      const transfer = await inOrg(request, async (tx) => {
        const member = await tx.organizationMember.findFirst({
          where: { organizationId: request.org!.id, user: { email } },
        });
        if (!member) throw new BadRequestError(`${email} is not a member of this organization`);
        if (member.userId === principal.id) throw new BadRequestError('You are already an admin');
        const transfer = await proposeTransfer(
          tx,
          { organizationId: request.org!.id },
          principal.id,
          member.userId
        );
        await orgAudit(
          request,
          {
            action: 'org.transfer_request',
            resourceType: 'transfer',
            resourceId: transfer.id,
            metadata: { to: email },
          },
          tx
        );
        return transfer;
      });
      return reply.code(201).send({ ...transferDto(transfer), to: email });
    }
  );

  // ─── Invitations (PPL-01/02) ──────────────────────────────────────────────

  const mailDeps = () => ({
    mailer: fastify.container.mailer,
    instanceName: fastify.container.settings.branding().name,
    logger: fastify.container.logger,
  });

  /** Emails an org invitation; the link always goes back to the inviter. */
  async function deliverOrgInvitation(
    request: FastifyRequest,
    invitation: Invitation,
    token: string
  ) {
    const url = acceptUrl(fastify.config.webOrigin, token);
    const emailed = await sendInvitationEmail(mailDeps(), {
      email: invitation.email,
      url,
      kind: 'organization',
      name: request.org!.name,
      role: invitation.role,
      inviter: request.principal?.type === 'user' ? request.principal.email : null,
    });
    if (emailed) {
      await inOrg(request, (tx) =>
        tx.invitation.update({ where: { id: invitation.id }, data: { lastSentAt: new Date() } })
      );
    }
    return { acceptUrl: url, emailed };
  }

  fastify.get<{ Params: OrgParams }>('/api/orgs/:orgSlug/invitations', admin, async (request) => {
    const invitations = await inOrg(request, (tx) =>
      tx.invitation.findMany({
        where: { organizationId: request.org!.id },
        orderBy: { createdAt: 'desc' },
        take: 200,
      })
    );
    return { invitations: invitations.map(invitationDto) };
  });

  /** PPL-01: invites someone to the organization by email; they join when they accept. */
  fastify.post<{ Params: OrgParams }>(
    '/api/orgs/:orgSlug/invitations',
    admin,
    async (request, reply) => {
      const body = AddOrgMemberSchema.parse(request.body);
      const email = body.email.trim().toLowerCase();
      const principal = request.principal!;
      const { invitation, token } = await inOrg(request, async (tx) => {
        const existing = await tx.organizationMember.findFirst({
          where: {
            organizationId: request.org!.id,
            user: { email: { equals: email, mode: 'insensitive' } },
          },
        });
        if (existing) throw new ConflictError(`${email} is already a member`);
        const created = await createInvitation(
          tx,
          { organizationId: request.org!.id },
          { email, role: body.role, invitedBy: `user:${principal.id}` }
        );
        await orgAudit(
          request,
          {
            action: 'org.member_invite',
            resourceType: 'invitation',
            resourceId: created.invitation.id,
            metadata: { email, role: body.role },
          },
          tx
        );
        return created;
      });
      const delivery = await deliverOrgInvitation(request, invitation, token);
      return reply.code(201).send({ ...invitationDto(invitation), ...delivery });
    }
  );

  const findOrgInvitation = async (tx: TenantTx, request: FastifyRequest, id: string) => {
    const invitation = await tx.invitation.findFirst({
      where: { id, organizationId: request.org!.id },
    });
    if (!invitation) throw new NotFoundError('Invitation not found');
    return invitation;
  };

  fastify.post<{ Params: OrgParams & { invitationId: string } }>(
    '/api/orgs/:orgSlug/invitations/:invitationId/resend',
    admin,
    async (request) => {
      const { invitation, token } = await inOrg(request, async (tx) => {
        const current = await findOrgInvitation(tx, request, request.params.invitationId);
        const renewed = await renewInvitation(tx, current);
        await orgAudit(
          request,
          {
            action: 'org.member_invite_resend',
            resourceType: 'invitation',
            resourceId: current.id,
            metadata: { email: current.email },
          },
          tx
        );
        return renewed;
      });
      return {
        ...invitationDto(invitation),
        ...(await deliverOrgInvitation(request, invitation, token)),
      };
    }
  );

  fastify.delete<{ Params: OrgParams & { invitationId: string } }>(
    '/api/orgs/:orgSlug/invitations/:invitationId',
    admin,
    async (request, reply) => {
      await inOrg(request, async (tx) => {
        const current = await findOrgInvitation(tx, request, request.params.invitationId);
        if (current.acceptedAt) throw new ConflictError('This invitation was already accepted');
        await tx.invitation.update({ where: { id: current.id }, data: { revokedAt: new Date() } });
        await orgAudit(
          request,
          {
            action: 'org.member_invite_revoke',
            resourceType: 'invitation',
            resourceId: current.id,
            metadata: { email: current.email },
          },
          tx
        );
      });
      return reply.code(204).send();
    }
  );

  // ─── People (PPL-03) ──────────────────────────────────────────────────────

  /**
   * Everyone with access to the organization or its workspaces: org role, workspace roles
   * and how they got them (invitation or org rules), implicit org-admin access, SCIM, last
   * sign-in and API keys created; plus pending invitations. `query` filters by email or
   * name, `workspace` by workspace; sorted by email with `cursor` (the last email) paging.
   */
  fastify.get<{
    Params: OrgParams;
    Querystring: { query?: string; workspace?: string; cursor?: string; limit?: string };
  }>('/api/orgs/:orgSlug/people', auditor, async (request) => {
    const org = request.org!;
    const q = request.query;
    const limit = Math.min(200, Math.max(1, Number(q.limit) || 50));
    const data = await inOrg(request, async (tx) => {
      const workspaces = await tx.workspace.findMany({
        where: { organizationId: org.id, deletedAt: null },
        select: { id: true, slug: true },
      });
      const wsIds = workspaces.map((w) => w.id);
      return {
        workspaces,
        orgMembers: await tx.organizationMember.findMany({ where: { organizationId: org.id } }),
        wsMembers: await tx.workspaceMember.findMany({
          where: { workspaceId: { in: wsIds }, joinedAt: { not: null } },
        }),
        scim: await tx.scimUser.findMany({
          where: { organizationId: org.id, deletedAt: null },
          select: { userId: true, active: true },
        }),
        keys: await tx.apiKey.groupBy({
          by: ['createdBy'],
          where: { workspaceId: { in: wsIds }, revokedAt: null, createdBy: { not: null } },
          _count: { _all: true },
        }),
        orgKeys: await tx.orgApiKey.groupBy({
          by: ['createdBy'],
          where: { organizationId: org.id, revokedAt: null, createdBy: { not: null } },
          _count: { _all: true },
        }),
        invitations: await tx.invitation.findMany({
          where: {
            OR: [{ organizationId: org.id }, { workspaceId: { in: wsIds } }],
            acceptedAt: null,
            revokedAt: null,
            expiresAt: { gt: new Date() },
          },
          orderBy: { createdAt: 'desc' },
        }),
        users: await tx.user.findMany({
          where: {
            OR: [
              { OrganizationMembers: { some: { organizationId: org.id } } },
              {
                WorkspaceMembers: { some: { workspaceId: { in: wsIds }, joinedAt: { not: null } } },
              },
            ],
          },
          select: { id: true, email: true, name: true, lastLoginAt: true },
        }),
      };
    });
    const slugOf = new Map(data.workspaces.map((w) => [w.id, w.slug]));
    const orgRole = new Map(data.orgMembers.map((m) => [m.userId, m.role]));
    const scim = new Map(data.scim.map((u) => [u.userId, u.active]));
    const keyCount = new Map<string, number>();
    for (const k of [...data.keys, ...data.orgKeys]) {
      keyCount.set(k.createdBy!, (keyCount.get(k.createdBy!) ?? 0) + k._count._all);
    }
    const term = q.query?.trim().toLowerCase();
    const people = data.users
      .map((u) => ({
        user: u,
        orgRole: orgRole.get(u.id) ?? null,
        workspaces: data.wsMembers
          .filter((m) => m.userId === u.id)
          .map((m) => ({
            slug: slugOf.get(m.workspaceId) ?? m.workspaceId,
            role: m.role,
            source: m.orgProvisioned ? 'org_rules' : 'member',
          })),
        // Org admins administer every workspace without a membership (ORG-08).
        implicitAdmin: orgRole.get(u.id) === 'org_admin',
        scim: scim.has(u.id) ? { active: scim.get(u.id)! } : null,
        apiKeys: keyCount.get(u.id) ?? 0,
      }))
      .filter(
        (p) =>
          (!term ||
            p.user.email.toLowerCase().includes(term) ||
            (p.user.name ?? '').toLowerCase().includes(term)) &&
          (!q.workspace || p.workspaces.some((w) => w.slug === q.workspace))
      )
      .sort((a, b) => a.user.email.localeCompare(b.user.email))
      .filter((p) => !q.cursor || p.user.email.localeCompare(q.cursor) > 0);
    const page = people.slice(0, limit);
    return {
      people: page.map((p) => ({
        ...p,
        user: { ...p.user, lastLoginAt: p.user.lastLoginAt?.toISOString() ?? null },
      })),
      nextCursor: people.length > limit ? page[page.length - 1].user.email : null,
      invitations: data.invitations.map((i) => ({
        ...invitationDto(i),
        workspace: i.workspaceId ? (slugOf.get(i.workspaceId) ?? null) : null,
      })),
    };
  });

  // ─── Workspaces (ORG-03/08) ───────────────────────────────────────────────

  fastify.post<{ Params: OrgParams }>(
    '/api/orgs/:orgSlug/workspaces',
    adminOrOrgKey,
    async (request, reply) => {
      const body = CreateOrgWorkspaceSchema.parse(request.body);
      const principal = request.principal!;
      // PLN-04: the organization's plan limits its workspaces.
      await fastify.container.quotas.require({ organizationId: request.org!.id }, 'workspaces');
      const workspace = await createWorkspace(
        // eslint-disable-next-line no-restricted-syntax -- MT-09: creates a new tenant
        systemDb,
        { name: body.name, slug: body.slug, owners: body.owners, organizationId: request.org!.id },
        principal.type === 'apiKey'
          ? { apiKeyId: principal.id, ip: request.ip }
          : { userId: principal.id, ip: request.ip },
        fastify.container.cache
      );
      // PPL-02: email the invited owners (best effort).
      for (const { invitation, token } of workspace.invited) {
        const emailed = await sendInvitationEmail(mailDeps(), {
          email: invitation.email,
          url: acceptUrl(fastify.config.webOrigin, token),
          kind: 'workspace',
          name: workspace.name,
          role: invitation.role,
          inviter: principal.type === 'user' ? principal.email : null,
        });
        if (emailed) {
          await withTenant(workspace.id, (tx) =>
            tx.invitation.update({ where: { id: invitation.id }, data: { lastSentAt: new Date() } })
          );
        }
      }
      await orgAudit(request, {
        action: 'org.workspace_create',
        resourceType: 'workspace',
        resourceId: workspace.id,
        metadata: { slug: workspace.slug, ...(body.owners.length && { owners: body.owners }) },
      });
      return reply
        .code(201)
        .send({ slug: workspace.slug, name: workspace.name, owners: body.owners });
    }
  );

  /** Moves a standalone workspace into the org: org admin and owner of the workspace. */
  fastify.post<{ Params: OrgWsParams }>(
    '/api/orgs/:orgSlug/workspaces/:workspaceSlug/attach',
    admin,
    async (request) => {
      const org = request.org!;
      await fastify.container.quotas.require({ organizationId: org.id }, 'workspaces'); // PLN-04
      // The workspace is outside the organization until attached: resolved by slug.
      // eslint-disable-next-line no-restricted-syntax -- MT-09: tenant resolution
      const workspace = await systemDb.workspace.findUnique({
        where: { slug: request.params.workspaceSlug },
      });
      const owner = workspace
        ? // eslint-disable-next-line no-restricted-syntax -- MT-09: tenant resolution
          await systemDb.workspaceMember.findFirst({
            where: {
              workspaceId: workspace.id,
              userId: request.principal!.id,
              role: 'owner',
              joinedAt: { not: null },
            },
          })
        : null;
      if (!workspace || !owner) throw new NotFoundError('No workspace you own with this slug');
      // The org's IdP can't vouch for ownership of a workspace outside the org.
      if (ssoScope(request.principal) && workspace.organizationId !== org.id) {
        throw new ForbiddenError('Attach workspaces from a session signed in directly');
      }
      if (workspace.organizationId === org.id)
        return { slug: workspace.slug, organization: org.slug };
      if (workspace.organizationId) {
        throw new ConflictError('The workspace belongs to another organization; detach it first');
      }
      // Not part of the organization yet: changed in its own workspace scope.
      await withTenant(workspace.id, (tx) =>
        tx.workspace.update({ where: { id: workspace.id }, data: { organizationId: org.id } })
      );
      await orgAudit(request, {
        action: 'org.workspace_attach',
        resourceType: 'workspace',
        resourceId: workspace.id,
        metadata: { slug: workspace.slug },
      });
      // Its manifests now include the org's shared modules, and it shares its own.
      await refreshWorkspace(workspace.id);
      await orgShared.fanOut(workspace.id, undefined, { force: true });
      return { slug: workspace.slug, organization: org.slug };
    }
  );

  /** Makes the workspace standalone again. Org keys and org admins lose access to it. */
  fastify.delete<{ Params: OrgWsParams; Querystring: { delete?: string; confirm?: string } }>(
    '/api/orgs/:orgSlug/workspaces/:workspaceSlug',
    adminOrOrgKey,
    async (request, reply) => {
      const org = request.org!;
      const workspace = await workspaceIn(request, request.params.workspaceSlug);
      // ORG-08: deleting needs the slug typed back.
      if (request.query.delete === 'true') {
        if (request.query.confirm !== workspace.slug) {
          throw new BadRequestError('Confirm the deletion with ?confirm=<workspace slug>');
        }
        // TLC-02: restorable by its owner or an org admin until the purge.
        const principal = request.principal!;
        const result = await softDeleteWorkspace(
          fastify.container,
          workspace,
          { type: principal.type === 'apiKey' ? 'apiKey' : 'user', id: principal.id },
          fastify.config.tenantRestoreDays
        );
        await orgAudit(request, {
          action: 'org.workspace_delete',
          resourceType: 'workspace',
          resourceId: workspace.id,
          metadata: { slug: workspace.slug, ...result },
        });
        return reply.code(204).send();
      }
      const siblings = await inOrg(request, async (tx) => {
        await tx.remoteModule.updateMany({
          where: { workspaceId: workspace.id, orgShared: true },
          data: { orgShared: false },
        });
        await tx.workspace.update({ where: { id: workspace.id }, data: { organizationId: null } });
        await orgAudit(
          request,
          {
            action: 'org.workspace_detach',
            resourceType: 'workspace',
            resourceId: workspace.id,
            metadata: { slug: workspace.slug },
          },
          tx
        );
        return tx.workspace.findMany({
          where: { organizationId: org.id, id: { not: workspace.id } },
          select: { id: true },
        });
      });
      await refreshWorkspace(workspace.id);
      // Its former siblings drop its shared modules.
      for (const sibling of siblings) await refreshWorkspace(sibling.id);
      return reply.code(204).send();
    }
  );

  /** Rebuilds every manifest of a workspace (its org-shared modules changed). */
  async function refreshWorkspace(workspaceId: string) {
    const envs = await withTenant(workspaceId, (tx) =>
      tx.environment.findMany({
        where: { hostApp: { workspaceId } },
        include: { hostApp: { include: { workspace: { select: { slug: true } } } } },
      })
    );
    for (const env of envs) {
      await invalidateManifest(cache, env.hostApp.workspace.slug, env.hostApp.slug, env.slug);
      await fastify.container.publisher.publish(env.id).catch(() => undefined);
    }
  }

  // ─── Audit (ORG-09) ───────────────────────────────────────────────────────

  fastify.get<{
    Params: OrgParams;
    Querystring: {
      workspace?: string;
      actor?: string;
      action?: string;
      from?: string;
      to?: string;
      cursor?: string;
      limit?: string;
    };
  }>('/api/orgs/:orgSlug/audit', auditor, async (request) => {
    const org = request.org!;
    const q = request.query;
    const limit = Math.min(200, Math.max(1, Number(q.limit) || 50));
    const date = parseDate;
    // Keyset pagination on (createdAt, id), newest first; the cursor is the last row.
    const [cursorAt, cursorId] = (q.cursor ?? '').split('|');
    const cursor = q.cursor ? { at: date(cursorAt)!, id: cursorId } : null;
    const createdAt = { gte: date(q.from), lte: date(q.to) };
    const page = cursor
      ? {
          OR: [{ createdAt: { lt: cursor.at } }, { createdAt: cursor.at, id: { lt: cursor.id } }],
        }
      : {};
    const order = [{ createdAt: 'desc' as const }, { id: 'desc' as const }];
    const { slugOf, events, orgEvents, actors } = await inOrg(request, async (tx) => {
      const filters = {
        createdAt,
        ...(await actorWhere(tx, q.actor)),
        ...(q.action && { action: { startsWith: q.action } }),
        ...page,
      };
      const workspaces = await tx.workspace.findMany({
        where: { organizationId: org.id, ...(q.workspace && { slug: q.workspace }) },
        select: { id: true, slug: true },
      });
      const slugOf = new Map(workspaces.map((w) => [w.id, w.slug]));
      const events = await tx.auditEvent.findMany({
        where: { workspaceId: { in: [...slugOf.keys()] }, ...filters },
        orderBy: order,
        take: limit + 1,
      });
      // Org-level events have no workspace.
      const orgEvents = q.workspace
        ? []
        : await tx.organizationAuditEvent.findMany({
            where: { organizationId: org.id, ...filters },
            orderBy: order,
            take: limit + 1,
          });
      // AUD-07: the org scope sees its users, its keys and its workspaces' keys.
      const actors = await resolveActors(tx, [...events, ...orgEvents]);
      return { slugOf, events, orgEvents, actors };
    });
    const merged = [
      ...events.map((e) => ({ ...e, workspace: slugOf.get(e.workspaceId) ?? null })),
      ...orgEvents.map((e) => ({ ...e, workspace: null })),
    ]
      .sort(
        (a, b) =>
          b.createdAt.getTime() - a.createdAt.getTime() || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0)
      )
      .slice(0, limit + 1);
    const items = merged.slice(0, limit);
    const last = items[items.length - 1];
    return {
      events: items.map((e) => ({
        id: e.id,
        workspace: e.workspace,
        actorType: e.actorType,
        actorId: e.actorId,
        actor: actorOf(actors, e),
        action: e.action,
        resourceType: e.resourceType,
        resourceId: e.resourceId,
        metadata: e.metadata,
        createdAt: e.createdAt.toISOString(),
      })),
      nextCursor:
        merged.length > limit && last ? `${last.createdAt.toISOString()}|${last.id}` : null,
    };
  });

  /** AUD-09: checks the organization's chain and each of its workspaces'. */
  fastify.get<{ Params: OrgParams }>(
    '/api/orgs/:orgSlug/audit/verify',
    auditor,
    async (request) => {
      const org = request.org!;
      return inOrg(request, async (tx) => {
        const organization = await verifyChain(tx, { kind: 'organization', id: org.id });
        const workspaces = await tx.workspace.findMany({
          where: { organizationId: org.id },
          select: { id: true, slug: true },
          orderBy: { slug: 'asc' },
        });
        const reports = [];
        for (const w of workspaces) {
          reports.push({
            slug: w.slug,
            ...(await verifyChain(tx, { kind: 'workspace', id: w.id })),
          });
        }
        return {
          ok: organization.ok && reports.every((r) => r.ok),
          organization,
          workspaces: reports,
        };
      });
    }
  );

  /** ORG-09: compliance export of the organization's audit log (workspaces and org). */
  fastify.get<{
    Params: OrgParams;
    Querystring: {
      format?: string;
      workspace?: string;
      actor?: string;
      action?: string;
      from?: string;
      to?: string;
    };
  }>('/api/orgs/:orgSlug/audit/export', auditor, async (request, reply) => {
    const org = request.org!;
    const q = request.query;
    const format = exportFormat(q.format);
    const filters = {
      ...dateRange(q),
      ...(await inOrg(request, (tx) => actorWhere(tx, q.actor))),
      ...(q.action && { action: { startsWith: q.action } }),
    };
    const workspaces = await inOrg(request, (tx) =>
      tx.workspace.findMany({
        where: { organizationId: org.id, ...(q.workspace && { slug: q.workspace }) },
        select: { id: true, slug: true },
      })
    );
    const slugOf = new Map(workspaces.map((w) => [w.id, w.slug]));
    await orgAudit(request, {
      action: 'org.audit_export',
      resourceType: 'organization',
      resourceId: org.id,
      metadata: {
        format,
        filters: {
          workspace: q.workspace,
          actor: q.actor,
          action: q.action,
          from: q.from,
          to: q.to,
        },
      },
    });
    // Each batch in its own org transaction: the download may take longer than one.
    const workspaceRows = keysetRows(async (after, take) =>
      (
        await inOrg(request, (tx) =>
          tx.auditEvent.findMany({
            where: { workspaceId: { in: [...slugOf.keys()] }, ...filters, ...afterWhere(after) },
            orderBy: NEWEST_FIRST,
            take,
          })
        )
      ).map((e) => ({ ...e, workspace: slugOf.get(e.workspaceId) ?? null }))
    );
    const orgRows = q.workspace
      ? (async function* () {})()
      : keysetRows(async (after, take) =>
          (
            await inOrg(request, (tx) =>
              tx.organizationAuditEvent.findMany({
                where: { organizationId: org.id, ...filters, ...afterWhere(after) },
                orderBy: NEWEST_FIRST,
                take,
              })
            )
          ).map((e) => ({ ...e, workspace: null }))
        );
    return sendExport(reply, mergeNewestFirst<ExportRow>(workspaceRows, orgRows), {
      format,
      name: org.slug,
      workspaceColumn: true,
    });
  });

  /** TLC-07: the organization's data and its live workspaces' as JSON Lines. */
  fastify.get<{ Params: OrgParams }>('/api/orgs/:orgSlug/export', admin, async (request, reply) => {
    const org = request.org!;
    await orgAudit(request, {
      action: 'org.export',
      resourceType: 'organization',
      resourceId: org.id,
    });
    return sendTenantExport(
      reply,
      { kind: 'organization', slug: org.slug },
      organizationRecords((fn) => inOrg(request, fn), org)
    );
  });

  // ─── Module catalog (ORG-10/12) ───────────────────────────────────────────

  /**
   * ORG-12, TAD-07: the catalog of the organization's modules. `query` matches name, slug
   * or description; filters by `workspace`, `environment` (an active version there) and
   * `shared`; paginated by `cursor` (a module id) and `limit`.
   */
  fastify.get<{
    Params: OrgParams;
    Querystring: {
      query?: string;
      workspace?: string;
      environment?: string;
      shared?: string;
      cursor?: string;
      limit?: string;
    };
  }>('/api/orgs/:orgSlug/modules', member, async (request) => {
    const q = request.query;
    const limit = Math.min(200, Math.max(1, Number(q.limit) || 50));
    const active = { status: 'active' as const, deletedAt: null };
    const where: Prisma.RemoteModuleWhereInput = {
      workspace: {
        organizationId: request.org!.id,
        deletedAt: null,
        ...(q.workspace && { slug: q.workspace }),
      },
      ...(q.query && {
        OR: [
          { name: { contains: q.query, mode: 'insensitive' } },
          { slug: { contains: q.query, mode: 'insensitive' } },
          { description: { contains: q.query, mode: 'insensitive' } },
        ],
      }),
      ...(q.shared !== undefined && q.shared !== '' && { orgShared: q.shared === 'true' }),
      ...(q.environment && {
        ModuleVersions: { some: { ...active, environment: { slug: q.environment } } },
      }),
    };
    const { rows, total } = await inOrg(request, async (tx) => ({
      rows: await tx.remoteModule.findMany({
        where,
        include: {
          workspace: { select: { slug: true, name: true } },
          hostApp: { select: { slug: true } },
          ModuleOwnerships: {
            include: { workspaceMember: { include: { user: { select: { email: true } } } } },
          },
          ModuleVersions: {
            where: active,
            include: { environment: { select: { slug: true } } },
          },
        },
        orderBy: [{ slug: 'asc' }, { id: 'asc' }],
        take: limit + 1,
        ...(q.cursor && { cursor: { id: q.cursor }, skip: 1 }),
      }),
      total: await tx.remoteModule.count({ where }),
    }));
    const modules = rows.slice(0, limit);
    return {
      total,
      nextCursor: rows.length > limit ? modules[modules.length - 1].id : null,
      modules: modules.map((m) => ({
        id: m.id,
        name: m.name,
        slug: m.slug,
        description: m.description,
        workspace: m.workspace.slug,
        workspaceName: m.workspace.name,
        hostApp: m.hostApp.slug,
        shared: m.orgShared,
        owners: m.ModuleOwnerships.map((o) => o.workspaceMember.user.email),
        versions: Object.fromEntries(m.ModuleVersions.map((v) => [v.environment.slug, v.version])),
      })),
    };
  });

  /**
   * TAD-07: which workspaces' manifests load a shared module: the organization's other
   * live workspaces with an environment of the same name as one it is active in (ORG-11).
   */
  fastify.get<{ Params: OrgParams & { moduleId: string } }>(
    '/api/orgs/:orgSlug/modules/:moduleId/consumers',
    member,
    async (request) => {
      const org = request.org!;
      const { module, environments } = await inOrg(request, async (tx) => {
        const module = await tx.remoteModule.findFirst({
          where: { id: request.params.moduleId, workspace: { organizationId: org.id } },
          include: {
            ModuleVersions: {
              where: { status: 'active', deletedAt: null },
              select: { environment: { select: { slug: true } } },
            },
          },
        });
        if (!module) throw new NotFoundError('Module not found');
        const slugs = [...new Set(module.ModuleVersions.map((v) => v.environment.slug))];
        const environments =
          module.orgShared && slugs.length
            ? await tx.environment.findMany({
                where: {
                  slug: { in: slugs },
                  hostApp: {
                    workspace: {
                      organizationId: org.id,
                      deletedAt: null,
                      id: { not: module.workspaceId },
                    },
                  },
                },
                select: {
                  slug: true,
                  hostApp: { select: { slug: true, workspace: { select: { slug: true } } } },
                },
                orderBy: [{ slug: 'asc' }],
              })
            : [];
        return { module, environments };
      });
      const byWorkspace = new Map<string, string[]>();
      for (const e of environments) {
        const ws = e.hostApp.workspace.slug;
        byWorkspace.set(ws, [...(byWorkspace.get(ws) ?? []), `${e.hostApp.slug}/${e.slug}`]);
      }
      return {
        id: module.id,
        shared: module.orgShared,
        consumers: [...byWorkspace]
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([workspace, envs]) => ({ workspace, environments: envs })),
      };
    }
  );

  // ORG-10: a workspace owner shares a module with the organization (or stops).
  fastify.put<{ Params: { workspaceSlug: string; moduleRef: string }; Body: { shared?: unknown } }>(
    '/api/workspaces/:workspaceSlug/modules/:moduleRef/shared',
    { preHandler: fastify.requireWorkspace('workspace:owner') },
    async (request) => {
      const workspace = request.workspace!;
      if (typeof request.body?.shared !== 'boolean') throw new BadRequestError('shared: boolean');
      if (!workspace.organizationId) {
        throw new ConflictError('Only workspaces in an organization can share modules');
      }
      const shared = request.body.shared;
      const ref = request.params.moduleRef;
      const updated = await fastify.container.withTenant(workspace.id, async (tx) => {
        const module = await tx.remoteModule.findFirst({
          where: { workspaceId: workspace.id, OR: [{ id: ref }, { slug: ref }] },
        });
        if (!module) throw new NotFoundError('Module not found');
        const updated = await tx.remoteModule.update({
          where: { id: module.id },
          data: { orgShared: shared },
        });
        await audit(
          tx,
          workspace.id,
          { principal: request.principal!, ip: request.ip },
          {
            action: shared ? 'module.org_shared' : 'module.org_unshared',
            resourceType: 'module',
            resourceId: module.id,
            metadata: { module: module.slug },
          }
        );
        return updated;
      });
      await orgShared.fanOut(workspace.id, undefined, { force: true });
      return { id: updated.id, slug: updated.slug, shared: updated.orgShared };
    }
  );

  // ─── Org API keys (ORG-13) ────────────────────────────────────────────────

  fastify.get<{ Params: OrgParams }>('/api/orgs/:orgSlug/keys', admin, async (request) => {
    const { keys, workspaces, creators, policy } = await inOrg(request, async (tx) => {
      const keys = await tx.orgApiKey.findMany({
        where: { organizationId: request.org!.id },
        orderBy: { createdAt: 'desc' },
      });
      const workspaces = await tx.workspace.findMany({
        where: { id: { in: keys.flatMap((k) => k.workspaceScope) } },
        select: { id: true, slug: true },
      });
      const creators = await tx.user.findMany({
        where: { id: { in: keys.flatMap((k) => (k.createdBy ? [k.createdBy] : [])) } },
        select: { id: true, email: true },
      });
      return { keys, workspaces, creators, policy: await orgPolicyFor(tx, request.org!.id) };
    });
    const slugOf = new Map(workspaces.map((w) => [w.id, w.slug]));
    const emailOf = new Map(creators.map((u) => [u.id, u.email]));
    return {
      keys: keys.map((k) => ({
        ...orgKeyDto(k),
        workspaces: k.workspaceScope.map((id) => slugOf.get(id) ?? id),
        createdBy: k.createdBy
          ? { id: k.createdBy, email: emailOf.get(k.createdBy) ?? null }
          : null,
        // POL-03
        policyViolations: k.revokedAt ? [] : keyPolicyViolations(policy, k),
      })),
    };
  });

  /** Creates an org key in the org transaction; the secret is returned once. */
  async function issueOrgKey(
    request: FastifyRequest,
    tx: TenantTx,
    data: {
      name: string;
      scopes: string[];
      workspaceIds: string[];
      moduleIds: string[];
      expiresAt: Date | null;
    }
  ) {
    // POL-03: the organization's own key policy applies to its keys too.
    assertKeyPolicy(await orgPolicyFor(tx, request.org!.id), data);
    const { secret, keyHash } = await generateApiKeySecret();
    const created = await tx.orgApiKey.create({
      data: {
        organizationId: request.org!.id,
        name: data.name,
        keyHash,
        scopes: data.scopes,
        workspaceScope: data.workspaceIds,
        moduleScope: data.moduleIds,
        expiresAt: data.expiresAt,
        createdBy: request.principal!.type === 'user' ? request.principal!.id : null,
      },
    });
    const record = await tx.orgApiKey.update({
      where: { id: created.id },
      data: { prefix: `hq_org_${created.id.slice(0, 8)}` },
    });
    return { record, key: formatOrgApiKey(record.id, secret) };
  }

  fastify.post<{ Params: OrgParams }>('/api/orgs/:orgSlug/keys', admin, async (request, reply) => {
    const body = CreateOrgApiKeySchema.parse(request.body);
    const org = request.org!;
    const { record, key } = await inOrg(request, async (tx) => {
      const workspaces = body.workspaces.length
        ? await tx.workspace.findMany({
            where: { organizationId: org.id, slug: { in: body.workspaces } },
            select: { id: true },
          })
        : [];
      if (workspaces.length !== body.workspaces.length) {
        throw new BadRequestError('Every workspace must belong to this organization');
      }
      if (body.moduleIds.length) {
        const found = await tx.remoteModule.count({
          where: { id: { in: body.moduleIds }, workspace: { organizationId: org.id } },
        });
        if (found !== body.moduleIds.length) {
          throw new BadRequestError('Every module must belong to this organization');
        }
      }
      const issued = await issueOrgKey(request, tx, {
        name: body.name,
        scopes: body.scopes,
        workspaceIds: workspaces.map((w) => w.id),
        moduleIds: body.moduleIds,
        expiresAt: body.expiresAt ?? null,
      });
      await orgAudit(
        request,
        {
          action: 'org.key_create',
          resourceType: 'org_api_key',
          resourceId: issued.record.id,
          metadata: { name: body.name, scopes: body.scopes, workspaces: body.workspaces },
        },
        tx
      );
      return issued;
    });
    // The key is shown once.
    return reply.code(201).send({ ...orgKeyDto(record), key });
  });

  /**
   * TAD-05 (as KEY-05): a new key with the same name, scopes and expiry; the old one keeps
   * working for `gracePeriodHours` so deployments can switch over.
   */
  fastify.post<{ Params: OrgParams & { keyId: string } }>(
    '/api/orgs/:orgSlug/keys/:keyId/rotate',
    admin,
    async (request, reply) => {
      const { gracePeriodHours } = RotateOrgKeySchema.parse(request.body ?? {});
      const { record, key, old } = await inOrg(request, async (tx) => {
        const old = await tx.orgApiKey.findFirst({
          where: { id: request.params.keyId, organizationId: request.org!.id, revokedAt: null },
        });
        if (!old || (old.gracePeriodEnd && old.gracePeriodEnd.getTime() <= Date.now())) {
          throw new NotFoundError('Key not found');
        }
        if (old.gracePeriodEnd) throw new ConflictError('This key was already rotated');
        const issued = await issueOrgKey(request, tx, {
          name: old.name,
          scopes: old.scopes,
          workspaceIds: old.workspaceScope,
          moduleIds: old.moduleScope,
          expiresAt: cappedExpiry(await orgPolicyFor(tx, old.organizationId), old.expiresAt),
        });
        await tx.orgApiKey.update({
          where: { id: old.id },
          data: { gracePeriodEnd: new Date(Date.now() + gracePeriodHours * 3_600_000) },
        });
        await orgAudit(
          request,
          {
            action: 'org.key_rotate',
            resourceType: 'org_api_key',
            resourceId: issued.record.id,
            metadata: { name: old.name, replaces: old.id, gracePeriodHours },
          },
          tx
        );
        return { ...issued, old };
      });
      fastify.forgetApiKey(old.id);
      return reply.code(201).send({ ...orgKeyDto(record), key, replaces: old.id });
    }
  );

  fastify.delete<{ Params: OrgParams & { keyId: string } }>(
    '/api/orgs/:orgSlug/keys/:keyId',
    admin,
    async (request, reply) => {
      await inOrg(request, async (tx) => {
        const { count } = await tx.orgApiKey.updateMany({
          where: { id: request.params.keyId, organizationId: request.org!.id, revokedAt: null },
          data: { revokedAt: new Date() },
        });
        if (!count) throw new NotFoundError('Key not found');
        await orgAudit(
          request,
          {
            action: 'org.key_revoke',
            resourceType: 'org_api_key',
            resourceId: request.params.keyId,
          },
          tx
        );
      });
      fastify.forgetApiKey(request.params.keyId);
      return reply.code(204).send();
    }
  );

  orgSsoRoutes(fastify, { admin, reader: auditor, orgAudit });
  orgDomainRoutes(fastify, { admin, orgAudit });
  orgPolicyRoutes(fastify, { admin, reader: auditor, orgAudit });
  orgEventRoutes(fastify, { admin, orgAudit });
  orgAuditSinkRoutes(fastify, { admin, orgAudit });

  // ─── Usage (USG-03, TAD-02) ───────────────────────────────────────────────

  fastify.get<{ Params: OrgParams; Querystring: { days?: string; format?: string } }>(
    '/api/orgs/:orgSlug/usage',
    billing,
    async (request, reply) => {
      const org = request.org!;
      const days = reportDays(request.query.days);
      const { plans, quotas } = fastify.container;
      const usage = await inOrg(request, async (tx) =>
        workspaceUsage(
          { plans, quotas },
          tx,
          await tx.workspace.findMany({
            where: { organizationId: org.id, deletedAt: null },
            select: { id: true, slug: true, name: true },
            orderBy: { name: 'asc' },
          }),
          days
        )
      );
      if (request.query.format === 'csv') return sendUsageCsv(reply, org.slug, usage);
      const entitlements = await plans.forOrg(org.id);
      return {
        days,
        warnAt: 0.8,
        plan: entitlements.plan,
        planExpiresAt: org.planExpiresAt?.toISOString() ?? null,
        limits: { workspaces: entitlements.limits.workspaces },
        totals: usageTotals(usage),
        workspaces: usage,
      };
    }
  );
};

export default orgRoutes;
