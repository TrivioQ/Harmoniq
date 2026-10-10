import { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { Prisma } from '@prisma/client';
import type { Organization } from '@prisma/client';
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
  CreateWorkspaceSchema,
  OrgRole,
  UpdateOrgMemberSchema,
  UpdateOrganizationSchema,
} from '@harmoniq/core/dist/schemas/ResourceSchemas';
import { formatOrgApiKey, generateApiKeySecret } from '../auth/apiKeys';
import { ssoScope } from '../plugins/authenticate';
import { audit } from '../services/audit';
import { invalidateManifest } from '../services/cacheKeys';
import { createWorkspace, deleteWorkspace } from '../services/workspaces';
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

declare module 'fastify' {
  interface FastifyRequest {
    /** Set by `requireOrg`. */
    org?: Organization;
    /** The caller's role in `org` (undefined for instance admins without one). */
    orgRole?: OrgRole;
  }
}

type OrgParams = { orgSlug: string };
type OrgWsParams = OrgParams & { workspaceSlug: string };

// ORG-01..15: organizations group workspaces. Org admins manage the org, its members,
// keys and workspaces, and administer every workspace in it; org members see the org.
const orgRoutes: FastifyPluginAsync = async (fastify) => {
  const { systemDb, cache, orgShared } = fastify.container;

  function requireOrg(level: 'member' | 'admin') {
    return async (request: FastifyRequest, reply: FastifyReply) => {
      await fastify.authenticate(request, reply);
      if (reply.sent) return;
      const principal = request.principal!;
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
      const org = await systemDb.organization.findFirst({
        where: { slug: orgSlug, deletedAt: null },
      });
      const membership = org
        ? await systemDb.organizationMember.findUnique({
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
      if (level === 'admin' && role !== 'org_admin') {
        return reply
          .code(403)
          .send({ error: { code: 'FORBIDDEN', message: 'Requires an organization admin' } });
      }
      request.org = org;
      request.orgRole = role;
    };
  }
  const member = { preHandler: requireOrg('member') };
  const admin = { preHandler: requireOrg('admin') };

  const orgAudit = (
    request: FastifyRequest,
    event: {
      action: string;
      resourceType: string;
      resourceId: string;
      metadata?: Record<string, unknown>;
    }
  ) =>
    systemDb.organizationAuditEvent.create({
      data: {
        organizationId: request.org!.id,
        actorType: 'user',
        actorId: request.principal!.id,
        ip: request.ip,
        ...event,
        metadata: event.metadata as Prisma.InputJsonValue | undefined,
      },
    });

  const workspaceIn = async (org: Organization, slug: string) => {
    const workspace = await systemDb.workspace.findFirst({
      where: { slug, organizationId: org.id },
    });
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
    try {
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

  /** ORG-14: the organization home: workspaces with activity and 24 h health. */
  fastify.get<{ Params: OrgParams }>('/api/orgs/:orgSlug', member, async (request) => {
    const org = request.org!;
    const workspaces = await systemDb.workspace.findMany({
      where: { organizationId: org.id },
      orderBy: { name: 'asc' },
      include: { _count: { select: { WorkspaceMembers: true, RemoteModules: true } } },
    });
    const ids = workspaces.map((w) => w.id);
    const since = new Date(Date.now() - 24 * 3_600_000);
    const [lastDeploys, health, recent] = await Promise.all([
      systemDb.moduleVersion.groupBy({
        by: ['workspaceId'],
        where: { workspaceId: { in: ids } },
        _max: { deployedAt: true },
      }),
      systemDb.moduleHealthRollup.groupBy({
        by: ['workspaceId'],
        where: { workspaceId: { in: ids }, hour: { gte: since } },
        _sum: { sampleCount: true, errorCount: true },
      }),
      systemDb.moduleVersion.findMany({
        where: { workspaceId: { in: ids } },
        orderBy: { deployedAt: 'desc' },
        take: 10,
        include: {
          remoteModule: { select: { slug: true } },
          environment: { select: { slug: true } },
          workspace: { select: { slug: true } },
        },
      }),
    ]);
    const lastDeploy = new Map(lastDeploys.map((d) => [d.workspaceId, d._max.deployedAt]));
    const healthOf = new Map(health.map((h) => [h.workspaceId, h._sum]));
    return {
      slug: org.slug,
      name: org.name,
      plan: org.plan,
      role: request.orgRole ?? null,
      workspaces: workspaces.map((w) => {
        const h = healthOf.get(w.id);
        return {
          slug: w.slug,
          name: w.name,
          members: w._count.WorkspaceMembers,
          modules: w._count.RemoteModules,
          lastDeployAt: lastDeploy.get(w.id)?.toISOString() ?? null,
          health: h?.sampleCount
            ? { samples: h.sampleCount, errorRate: (h.errorCount ?? 0) / h.sampleCount }
            : null,
        };
      }),
      recentDeploys: recent.map((v) => ({
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
    const org = await systemDb.organization.update({ where: { id: request.org!.id }, data: body });
    await orgAudit(request, {
      action: 'org.update',
      resourceType: 'organization',
      resourceId: org.id,
      metadata: body,
    });
    return { slug: org.slug, name: org.name };
  });

  // Only an empty organization can be deleted (workspaces are detached or deleted first).
  fastify.delete<{ Params: OrgParams }>('/api/orgs/:orgSlug', admin, async (request, reply) => {
    const org = request.org!;
    if (await systemDb.workspace.count({ where: { organizationId: org.id } })) {
      throw new ConflictError('Detach or delete the organization’s workspaces first');
    }
    await systemDb.organization.update({ where: { id: org.id }, data: { deletedAt: new Date() } });
    await systemDb.orgApiKey.updateMany({
      where: { organizationId: org.id, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    await orgAudit(request, {
      action: 'org.delete',
      resourceType: 'organization',
      resourceId: org.id,
    });
    return reply.code(204).send();
  });

  // ─── Members (ORG-04/08) ──────────────────────────────────────────────────

  fastify.get<{ Params: OrgParams }>('/api/orgs/:orgSlug/members', member, async (request) => {
    const members = await systemDb.organizationMember.findMany({
      where: { organizationId: request.org!.id },
      include: { user: { select: { id: true, email: true, name: true, avatarUrl: true } } },
      orderBy: { createdAt: 'asc' },
    });
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
      // As with workspace invitations: their first sign-in with this email links to it.
      const user =
        (await systemDb.user.findFirst({
          where: { email: { equals: email, mode: 'insensitive' } },
        })) ?? (await systemDb.user.create({ data: { email } }));
      try {
        const created = await systemDb.organizationMember.create({
          data: { organizationId: org.id, userId: user.id, role: body.role },
        });
        await orgAudit(request, {
          action: 'org.member_add',
          resourceType: 'org_member',
          resourceId: created.id,
          metadata: { email, role: body.role },
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

  const adminCount = (organizationId: string) =>
    systemDb.organizationMember.count({ where: { organizationId, role: 'org_admin' } });

  const findMember = async (request: FastifyRequest, id: string) => {
    const found = await systemDb.organizationMember.findFirst({
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
      const current = await findMember(request, request.params.memberId);
      if (current.role === 'org_admin' && role !== 'org_admin') {
        if ((await adminCount(request.org!.id)) <= 1) {
          throw new ConflictError('An organization must keep at least one admin');
        }
      }
      const updated = await systemDb.organizationMember.update({
        where: { id: current.id },
        data: { role },
      });
      await orgAudit(request, {
        action: 'org.member_role_change',
        resourceType: 'org_member',
        resourceId: current.id,
        metadata: { from: current.role, to: role },
      });
      return { id: updated.id, role: updated.role };
    }
  );

  fastify.delete<{ Params: OrgParams & { memberId: string } }>(
    '/api/orgs/:orgSlug/members/:memberId',
    admin,
    async (request, reply) => {
      const current = await findMember(request, request.params.memberId);
      if (current.role === 'org_admin' && (await adminCount(request.org!.id)) <= 1) {
        throw new ConflictError('An organization must keep at least one admin');
      }
      await systemDb.organizationMember.delete({ where: { id: current.id } });
      await orgAudit(request, {
        action: 'org.member_remove',
        resourceType: 'org_member',
        resourceId: current.id,
        metadata: { userId: current.userId, role: current.role },
      });
      return reply.code(204).send();
    }
  );

  // ─── Workspaces (ORG-03/08) ───────────────────────────────────────────────

  fastify.post<{ Params: OrgParams }>(
    '/api/orgs/:orgSlug/workspaces',
    admin,
    async (request, reply) => {
      const body = CreateWorkspaceSchema.parse(request.body);
      const workspace = await createWorkspace(
        systemDb,
        { ...body, organizationId: request.org!.id },
        { userId: request.principal!.id, ip: request.ip }
      );
      await orgAudit(request, {
        action: 'org.workspace_create',
        resourceType: 'workspace',
        resourceId: workspace.id,
        metadata: { slug: workspace.slug },
      });
      return reply.code(201).send({ slug: workspace.slug, name: workspace.name });
    }
  );

  /** Moves a standalone workspace into the org: org admin and owner of the workspace. */
  fastify.post<{ Params: OrgWsParams }>(
    '/api/orgs/:orgSlug/workspaces/:workspaceSlug/attach',
    admin,
    async (request) => {
      const org = request.org!;
      const workspace = await systemDb.workspace.findUnique({
        where: { slug: request.params.workspaceSlug },
      });
      const owner = workspace
        ? await systemDb.workspaceMember.findFirst({
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
      await systemDb.workspace.update({
        where: { id: workspace.id },
        data: { organizationId: org.id },
      });
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
    admin,
    async (request, reply) => {
      const org = request.org!;
      const workspace = await workspaceIn(org, request.params.workspaceSlug);
      // ORG-08: deleting needs the slug typed back.
      if (request.query.delete === 'true') {
        if (request.query.confirm !== workspace.slug) {
          throw new BadRequestError('Confirm the deletion with ?confirm=<workspace slug>');
        }
        await deleteWorkspace(fastify.container, workspace);
        await orgAudit(request, {
          action: 'org.workspace_delete',
          resourceType: 'workspace',
          resourceId: workspace.id,
          metadata: { slug: workspace.slug },
        });
        return reply.code(204).send();
      }
      await systemDb.workspace.update({
        where: { id: workspace.id },
        data: { organizationId: null },
      });
      await systemDb.remoteModule.updateMany({
        where: { workspaceId: workspace.id, orgShared: true },
        data: { orgShared: false },
      });
      await orgAudit(request, {
        action: 'org.workspace_detach',
        resourceType: 'workspace',
        resourceId: workspace.id,
        metadata: { slug: workspace.slug },
      });
      await refreshWorkspace(workspace.id);
      // Its former siblings drop its shared modules.
      for (const sibling of await systemDb.workspace.findMany({
        where: { organizationId: org.id },
        select: { id: true },
      })) {
        await refreshWorkspace(sibling.id);
      }
      return reply.code(204).send();
    }
  );

  /** Rebuilds every manifest of a workspace (its org-shared modules changed). */
  async function refreshWorkspace(workspaceId: string) {
    const envs = await systemDb.environment.findMany({
      where: { hostApp: { workspaceId } },
      include: { hostApp: { include: { workspace: { select: { slug: true } } } } },
    });
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
  }>('/api/orgs/:orgSlug/audit', admin, async (request) => {
    const org = request.org!;
    const q = request.query;
    const limit = Math.min(200, Math.max(1, Number(q.limit) || 50));
    const date = (v?: string) => {
      if (!v) return undefined;
      const d = new Date(v);
      if (Number.isNaN(d.getTime())) throw new BadRequestError(`Invalid date: ${v}`);
      return d;
    };
    // Keyset pagination on (createdAt, id), newest first; the cursor is the last row.
    const [cursorAt, cursorId] = (q.cursor ?? '').split('|');
    const cursor = q.cursor ? { at: date(cursorAt)!, id: cursorId } : null;
    const createdAt = { gte: date(q.from), lte: date(q.to) };
    const page = cursor
      ? {
          OR: [{ createdAt: { lt: cursor.at } }, { createdAt: cursor.at, id: { lt: cursor.id } }],
        }
      : {};
    const filters = {
      createdAt,
      ...(q.actor && { actorId: q.actor }),
      ...(q.action && { action: { startsWith: q.action } }),
      ...page,
    };
    const workspaces = await systemDb.workspace.findMany({
      where: { organizationId: org.id, ...(q.workspace && { slug: q.workspace }) },
      select: { id: true, slug: true },
    });
    const slugOf = new Map(workspaces.map((w) => [w.id, w.slug]));
    const order = [{ createdAt: 'desc' as const }, { id: 'desc' as const }];
    const [events, orgEvents] = await Promise.all([
      systemDb.auditEvent.findMany({
        where: { workspaceId: { in: [...slugOf.keys()] }, ...filters },
        orderBy: order,
        take: limit + 1,
      }),
      // Org-level events have no workspace.
      q.workspace
        ? Promise.resolve([])
        : systemDb.organizationAuditEvent.findMany({
            where: { organizationId: org.id, ...filters },
            orderBy: order,
            take: limit + 1,
          }),
    ]);
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
  }>('/api/orgs/:orgSlug/audit/export', admin, async (request, reply) => {
    const org = request.org!;
    const q = request.query;
    const format = exportFormat(q.format);
    const filters = {
      ...dateRange(q),
      ...(q.actor && { actorId: q.actor }),
      ...(q.action && { action: { startsWith: q.action } }),
    };
    const workspaces = await systemDb.workspace.findMany({
      where: { organizationId: org.id, ...(q.workspace && { slug: q.workspace }) },
      select: { id: true, slug: true },
    });
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
    const workspaceRows = keysetRows(async (after, take) =>
      (
        await systemDb.auditEvent.findMany({
          where: { workspaceId: { in: [...slugOf.keys()] }, ...filters, ...afterWhere(after) },
          orderBy: NEWEST_FIRST,
          take,
        })
      ).map((e) => ({ ...e, workspace: slugOf.get(e.workspaceId) ?? null }))
    );
    const orgRows = q.workspace
      ? (async function* () {})()
      : keysetRows(async (after, take) =>
          (
            await systemDb.organizationAuditEvent.findMany({
              where: { organizationId: org.id, ...filters, ...afterWhere(after) },
              orderBy: NEWEST_FIRST,
              take,
            })
          ).map((e) => ({ ...e, workspace: null }))
        );
    return sendExport(reply, mergeNewestFirst<ExportRow>(workspaceRows, orgRows), {
      format,
      name: org.slug,
      workspaceColumn: true,
    });
  });

  // ─── Module catalog (ORG-10/12) ───────────────────────────────────────────

  fastify.get<{ Params: OrgParams }>('/api/orgs/:orgSlug/modules', member, async (request) => {
    const modules = await systemDb.remoteModule.findMany({
      where: { workspace: { organizationId: request.org!.id } },
      include: {
        workspace: { select: { slug: true, name: true } },
        hostApp: { select: { slug: true } },
        ModuleOwnerships: {
          include: { workspaceMember: { include: { user: { select: { email: true } } } } },
        },
        ModuleVersions: {
          where: { status: 'active', deletedAt: null },
          include: { environment: { select: { slug: true } } },
        },
      },
      orderBy: [{ slug: 'asc' }, { workspace: { slug: 'asc' } }],
    });
    return {
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
    const keys = await systemDb.orgApiKey.findMany({
      where: { organizationId: request.org!.id },
      orderBy: { createdAt: 'desc' },
    });
    const workspaces = await systemDb.workspace.findMany({
      where: { id: { in: keys.flatMap((k) => k.workspaceScope) } },
      select: { id: true, slug: true },
    });
    const slugOf = new Map(workspaces.map((w) => [w.id, w.slug]));
    return {
      keys: keys.map((k) => ({
        id: k.id,
        name: k.name,
        prefix: k.prefix,
        scopes: k.scopes,
        workspaces: k.workspaceScope.map((id) => slugOf.get(id) ?? id),
        moduleIds: k.moduleScope,
        expiresAt: k.expiresAt?.toISOString() ?? null,
        lastUsedAt: k.lastUsedAt?.toISOString() ?? null,
        revokedAt: k.revokedAt?.toISOString() ?? null,
        createdAt: k.createdAt.toISOString(),
      })),
    };
  });

  fastify.post<{ Params: OrgParams }>('/api/orgs/:orgSlug/keys', admin, async (request, reply) => {
    const body = CreateOrgApiKeySchema.parse(request.body);
    const org = request.org!;
    const workspaces = body.workspaces.length
      ? await systemDb.workspace.findMany({
          where: { organizationId: org.id, slug: { in: body.workspaces } },
          select: { id: true },
        })
      : [];
    if (workspaces.length !== body.workspaces.length) {
      throw new BadRequestError('Every workspace must belong to this organization');
    }
    if (body.moduleIds.length) {
      const found = await systemDb.remoteModule.count({
        where: { id: { in: body.moduleIds }, workspace: { organizationId: org.id } },
      });
      if (found !== body.moduleIds.length) {
        throw new BadRequestError('Every module must belong to this organization');
      }
    }
    const { secret, keyHash } = await generateApiKeySecret();
    const record = await systemDb.orgApiKey.create({
      data: {
        organizationId: org.id,
        name: body.name,
        keyHash,
        scopes: body.scopes,
        workspaceScope: workspaces.map((w) => w.id),
        moduleScope: body.moduleIds,
        expiresAt: body.expiresAt,
        createdBy: request.principal!.id,
      },
    });
    const prefix = `hq_org_${record.id.slice(0, 8)}`;
    await systemDb.orgApiKey.update({ where: { id: record.id }, data: { prefix } });
    await orgAudit(request, {
      action: 'org.key_create',
      resourceType: 'org_api_key',
      resourceId: record.id,
      metadata: { name: body.name, scopes: body.scopes, workspaces: body.workspaces },
    });
    return reply.code(201).send({
      id: record.id,
      name: record.name,
      prefix,
      // Shown once.
      key: formatOrgApiKey(record.id, secret),
    });
  });

  fastify.delete<{ Params: OrgParams & { keyId: string } }>(
    '/api/orgs/:orgSlug/keys/:keyId',
    admin,
    async (request, reply) => {
      const { count } = await systemDb.orgApiKey.updateMany({
        where: { id: request.params.keyId, organizationId: request.org!.id, revokedAt: null },
        data: { revokedAt: new Date() },
      });
      if (!count) throw new NotFoundError('Key not found');
      fastify.forgetApiKey(request.params.keyId);
      await orgAudit(request, {
        action: 'org.key_revoke',
        resourceType: 'org_api_key',
        resourceId: request.params.keyId,
      });
      return reply.code(204).send();
    }
  );

  orgSsoRoutes(fastify, { admin, orgAudit });
};

export default orgRoutes;
