// Copyright The Harmoniq Authors
// SPDX-License-Identifier: Apache-2.0

/* eslint-disable no-restricted-syntax -- MT-09: instance administration spans every tenant (INST-05) */

import { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { createHash, timingSafeEqual } from 'crypto';
import { Prisma } from '@prisma/client';
import {
  BadRequestError,
  ConflictError,
  ForbiddenError,
  NotFoundError,
} from '@harmoniq/core/dist/errors/AppError';
import {
  GrantInstanceAdminSchema,
  SetPlanSchema,
  SetupCompleteSchema,
  SetupTokenSchema,
  SuspendWorkspaceSchema,
} from '@harmoniq/core/dist/schemas/AdminSchemas';
import {
  INSTANCE_SETTING_KEYS,
  InstanceSettingKey,
  StorageSettings,
} from '@harmoniq/core/dist/schemas/InstanceSettingsSchemas';
import {
  instanceHealth,
  probeCache,
  probeDatabase,
  probeStorage,
} from '../services/instanceHealth';
import { restoreWorkspace, softDeleteWorkspace } from '../services/tenantLifecycle';
import { storageTargetFromSettings } from '../adapters/storage/createStorage';
import {
  NEWEST_FIRST,
  afterWhere,
  dateRange,
  exportFormat,
  keysetRows,
  sendExport,
} from '../services/auditExport';
import { actorOf, actorWhere, parseDate, resolveActors } from '../services/auditActors';

// InstanceConfig key marking the one-time setup token as consumed (INST-04).
const SETUP_COMPLETED_KEY = 'setup.completed';
const PAGE = 50;

function tokensMatch(provided: unknown, expected: string): boolean {
  if (typeof provided !== 'string') return false;
  // Hash first so lengths match and comparison time doesn't depend on the input.
  const a = createHash('sha256').update(provided).digest();
  const b = createHash('sha256').update(expected).digest();
  return timingSafeEqual(a, b);
}

/** Keyset pagination by (createdAt, id), newest first; the cursor is `<iso>|<id>`. */
function cursorWhere(cursor: string | undefined) {
  if (!cursor) return {};
  const [at, id] = cursor.split('|');
  const createdAt = new Date(at);
  if (!id || Number.isNaN(createdAt.getTime())) throw new BadRequestError('Invalid cursor');
  return { OR: [{ createdAt: { lt: createdAt } }, { createdAt, id: { lt: id } }] };
}
const nextCursor = <T extends { createdAt: Date; id: string }>(rows: T[], take: number) =>
  rows.length === take ? `${rows[take - 1].createdAt.toISOString()}|${rows[take - 1].id}` : null;

// INST-01..10, 18: the first-boot wizard and the instance admin API (`/api/admin/*`).
const adminRoutes: FastifyPluginAsync = async (fastify) => {
  const { systemDb } = fastify.container;
  const admin = { preHandler: fastify.requireInstanceAdmin };
  const setupLimit = { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } };
  const { settings } = fastify.container;
  const adapters = () => ({
    cache: fastify.config.cacheAdapter,
    storage: settings.storageAdapter(),
  });

  /** INST-18: instance changes, append-only; never secrets or config values. */
  const instanceAudit = (
    request: FastifyRequest,
    event: {
      action: string;
      resourceType: string;
      resourceId: string;
      metadata?: Record<string, unknown>;
    }
  ) =>
    systemDb.instanceAuditEvent.create({
      data: {
        actorType: 'user',
        actorId: request.principal!.id,
        ip: request.ip,
        ...event,
        metadata: event.metadata as Prisma.InputJsonValue | undefined,
      },
    });

  // ─── First-boot wizard (INST-01..04) ──────────────────────────────────────

  const setupConsumed = async () =>
    !!(await systemDb.instanceConfig.findUnique({ where: { key: SETUP_COMPLETED_KEY } }));

  /** INST-02: 403 unless the token is configured, matches and hasn't been used. */
  const requireSetupToken = async (body: unknown) => {
    const { setupToken } = SetupTokenSchema.parse(body ?? {});
    const expected = fastify.config.setupToken;
    if (!expected || !tokensMatch(setupToken, expected) || (await setupConsumed())) {
      throw new ForbiddenError('Invalid or already used setup token');
    }
  };

  /** INST-14: the instance's name and look, for the dashboard (public). */
  fastify.get('/api/instance', async () => ({ branding: settings.branding() }));

  fastify.get('/api/admin/setup', setupLimit, async () => ({
    needed: !(await setupConsumed()),
    tokenConfigured: !!fastify.config.setupToken,
  }));

  // Step 2: database and cache connectivity.
  fastify.post('/api/admin/setup/check', setupLimit, async (request) => {
    await requireSetupToken(request.body);
    const [database, cache] = await Promise.all([
      probeDatabase(fastify.container),
      probeCache(fastify.container),
    ]);
    return { database, cache: { ...cache, adapter: adapters().cache } };
  });

  // Step 3: the default storage adapter (write, read back, delete).
  fastify.post('/api/admin/setup/storage', setupLimit, async (request) => {
    await requireSetupToken(request.body);
    const target = fastify.container.instanceStorage;
    return {
      adapter: adapters().storage,
      ...(target ? await probeStorage(target) : { ok: true, latencyMs: 0 }),
    };
  });

  // Step 4 needs at least one way to sign in; then the first admin is created (step 1's
  // data) and the token is consumed (INST-04).
  fastify.post('/api/admin/setup', setupLimit, async (request) => {
    await requireSetupToken(request.body);
    const { email, name } = SetupCompleteSchema.parse(request.body);
    const signIn = fastify.ssoProviders.list().map((p) => p.id) as string[];
    if (fastify.container.mailer) signIn.push('email');
    if (fastify.config.devLogin) signIn.push('dev');
    if (!signIn.length) {
      throw new BadRequestError(
        'No sign-in method is available: configure GitHub, OIDC or SMTP (email) first'
      );
    }

    let newAdmin;
    try {
      newAdmin = await systemDb.$transaction(async (tx) => {
        // Unique key: a concurrent second setup fails here instead of creating two admins.
        await tx.instanceConfig.create({
          data: {
            key: SETUP_COMPLETED_KEY,
            value: { at: new Date().toISOString(), email },
            updatedBy: 'setup',
          },
        });
        const user =
          (await tx.user.findUnique({ where: { email } })) ??
          (await tx.user.create({ data: { email, name: name || 'Admin' } }));
        // Upsert: the user may hold a previously revoked admin grant.
        const grant = await tx.instanceAdmin.upsert({
          where: { userId: user.id },
          create: { userId: user.id, grantedBy: 'system' },
          update: { revokedAt: null, grantedBy: 'system' },
          include: { user: true },
        });
        await tx.instanceAuditEvent.create({
          data: {
            actorType: 'system',
            actorId: 'system:setup',
            action: 'instance.setup_completed',
            resourceType: 'user',
            resourceId: user.id,
            ip: request.ip,
            metadata: { signIn },
          },
        });
        return grant;
      });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        throw new ForbiddenError('Invalid or already used setup token');
      }
      throw err;
    }

    // No session is issued here: the admin signs in normally with this (verified) email,
    // which links their identity to this user.
    return {
      message: 'Admin created. Sign in with this email address to continue.',
      user: { id: newAdmin.user.id, email: newAdmin.user.email, name: newAdmin.user.name },
      signIn,
    };
  });

  // ─── System health (INST-08) ──────────────────────────────────────────────

  fastify.get('/api/admin/health', admin, async () => {
    const [health, workspaces, modules, users] = await Promise.all([
      instanceHealth(fastify.container, adapters()),
      systemDb.workspace.count(),
      systemDb.remoteModule.count(),
      systemDb.user.count(),
    ]);
    return { ...health, stats: { workspaces, modules, users } };
  });

  // ─── Workspaces (INST-09) ─────────────────────────────────────────────────

  fastify.get<{ Querystring: { query?: string; cursor?: string } }>(
    '/api/admin/workspaces',
    admin,
    async (request) => {
      const query = request.query.query?.trim();
      const rows = await systemDb.workspace.findMany({
        where: {
          ...(query && {
            OR: [
              { slug: { contains: query, mode: 'insensitive' } },
              { name: { contains: query, mode: 'insensitive' } },
            ],
          }),
          ...cursorWhere(request.query.cursor),
        },
        include: {
          organization: { select: { slug: true, plan: true } },
          WorkspaceConfig: { select: { plan: true } },
          _count: {
            // Joined members only: pending invitations aren't members yet.
            select: {
              RemoteModules: true,
              WorkspaceMembers: { where: { joinedAt: { not: null } } },
              ModuleVersions: true,
            },
          },
        },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: PAGE,
      });
      return {
        workspaces: rows.map((w) => ({
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
          suspendedAt: w.suspendedAt,
          // TLC-02: deleted, restorable until `purgeAfter`.
          deletedAt: w.deletedAt,
          purgeAfter: w.purgeAfter,
          suspendedReason: w.suspendedReason,
          createdAt: w.createdAt,
        })),
        nextCursor: nextCursor(rows, PAGE),
      };
    }
  );

  const workspaceBySlug = async (slug: string) => {
    const workspace = await systemDb.workspace.findUnique({ where: { slug } });
    if (!workspace) throw new NotFoundError('Workspace not found');
    return workspace;
  };

  fastify.post<{ Params: { slug: string } }>(
    '/api/admin/workspaces/:slug/suspend',
    admin,
    async (request) => {
      const { reason } = SuspendWorkspaceSchema.parse(request.body ?? {});
      const workspace = await workspaceBySlug(request.params.slug);
      const updated = await systemDb.workspace.update({
        where: { id: workspace.id },
        data: { suspendedAt: workspace.suspendedAt ?? new Date(), suspendedReason: reason ?? null },
      });
      await instanceAudit(request, {
        action: 'instance.workspace_suspend',
        resourceType: 'workspace',
        resourceId: workspace.id,
        metadata: { slug: workspace.slug, reason: reason ?? null },
      });
      return {
        slug: updated.slug,
        suspendedAt: updated.suspendedAt,
        suspendedReason: reason ?? null,
      };
    }
  );

  fastify.post<{ Params: { slug: string } }>(
    '/api/admin/workspaces/:slug/unsuspend',
    admin,
    async (request) => {
      const workspace = await workspaceBySlug(request.params.slug);
      await systemDb.workspace.update({
        where: { id: workspace.id },
        data: { suspendedAt: null, suspendedReason: null },
      });
      await instanceAudit(request, {
        action: 'instance.workspace_unsuspend',
        resourceType: 'workspace',
        resourceId: workspace.id,
        metadata: { slug: workspace.slug },
      });
      return { slug: workspace.slug, suspendedAt: null };
    }
  );

  fastify.delete<{ Params: { slug: string }; Querystring: { confirm?: string } }>(
    '/api/admin/workspaces/:slug',
    admin,
    async (request, reply) => {
      const workspace = await workspaceBySlug(request.params.slug);
      if (request.query.confirm !== workspace.slug) {
        throw new BadRequestError('Confirm the deletion with ?confirm=<workspace slug>');
      }
      if (workspace.deletedAt) throw new ConflictError('The workspace is already deleted');
      // TLC-02: restorable for HARMONIQ_TENANT_RESTORE_DAYS (0: purged at once).
      const result = await softDeleteWorkspace(
        fastify.container,
        workspace,
        { type: 'user', id: request.principal!.id },
        fastify.config.tenantRestoreDays
      );
      await instanceAudit(request, {
        action: 'instance.workspace_delete',
        resourceType: 'workspace',
        resourceId: workspace.id,
        metadata: { slug: workspace.slug, ...result },
      });
      return reply.code(204).send();
    }
  );

  /** TLC-02: undoes a deletion before the purge. */
  fastify.post<{ Params: { slug: string } }>(
    '/api/admin/workspaces/:slug/restore',
    admin,
    async (request) => {
      const workspace = await workspaceBySlug(request.params.slug);
      if (!workspace.deletedAt) throw new ConflictError('The workspace is not deleted');
      await restoreWorkspace(fastify.container, workspace);
      await instanceAudit(request, {
        action: 'instance.workspace_restore',
        resourceType: 'workspace',
        resourceId: workspace.id,
        metadata: { slug: workspace.slug },
      });
      return { slug: workspace.slug, deletedAt: null };
    }
  );

  // ─── Plans (PLN-01..03) ───────────────────────────────────────────────────

  fastify.put<{ Params: { slug: string } }>(
    '/api/admin/workspaces/:slug/plan',
    admin,
    async (request) => {
      const { plan } = SetPlanSchema.parse(request.body);
      const workspace = await workspaceBySlug(request.params.slug);
      await systemDb.workspaceConfig.upsert({
        where: { workspaceId: workspace.id },
        create: { workspaceId: workspace.id, plan },
        update: { plan },
      });
      fastify.container.plans.forget();
      await instanceAudit(request, {
        action: 'instance.workspace_plan',
        resourceType: 'workspace',
        resourceId: workspace.id,
        metadata: { slug: workspace.slug, plan },
      });
      return { slug: workspace.slug, plan };
    }
  );

  fastify.get('/api/admin/orgs', admin, async () => {
    // Deleted organizations too (until purged), so they can be restored.
    const orgs = await systemDb.organization.findMany({
      include: { _count: { select: { Workspaces: true, Members: true } } },
      orderBy: { name: 'asc' },
    });
    return {
      organizations: orgs.map((o) => ({
        slug: o.slug,
        name: o.name,
        plan: o.plan,
        workspaces: o._count.Workspaces,
        members: o._count.Members,
        suspendedAt: o.suspendedAt,
        suspendedReason: o.suspendedReason,
        deletedAt: o.deletedAt,
        purgeAfter: o.purgeAfter,
      })),
    };
  });

  const orgBySlug = async (slug: string) => {
    const org = await systemDb.organization.findUnique({ where: { slug } });
    if (!org) throw new NotFoundError('Organization not found');
    return org;
  };

  /**
   * TLC-04: every workspace of the organization (and its org keys) refuses changes while
   * suspended; reads and manifests keep working.
   */
  fastify.post<{ Params: { slug: string } }>(
    '/api/admin/orgs/:slug/suspend',
    admin,
    async (request) => {
      const { reason } = SuspendWorkspaceSchema.parse(request.body ?? {});
      const org = await orgBySlug(request.params.slug);
      const updated = await systemDb.organization.update({
        where: { id: org.id },
        data: { suspendedAt: org.suspendedAt ?? new Date(), suspendedReason: reason ?? null },
      });
      await instanceAudit(request, {
        action: 'instance.org_suspend',
        resourceType: 'organization',
        resourceId: org.id,
        metadata: { slug: org.slug, reason: reason ?? null },
      });
      return { slug: org.slug, suspendedAt: updated.suspendedAt, suspendedReason: reason ?? null };
    }
  );

  fastify.post<{ Params: { slug: string } }>(
    '/api/admin/orgs/:slug/unsuspend',
    admin,
    async (request) => {
      const org = await orgBySlug(request.params.slug);
      await systemDb.organization.update({
        where: { id: org.id },
        data: { suspendedAt: null, suspendedReason: null },
      });
      await instanceAudit(request, {
        action: 'instance.org_unsuspend',
        resourceType: 'organization',
        resourceId: org.id,
        metadata: { slug: org.slug },
      });
      return { slug: org.slug, suspendedAt: null };
    }
  );

  /** TLC-02: an organization its admins deleted, back before the purge. */
  fastify.post<{ Params: { slug: string } }>(
    '/api/admin/orgs/:slug/restore',
    admin,
    async (request) => {
      const org = await orgBySlug(request.params.slug);
      if (!org.deletedAt) throw new ConflictError('The organization is not deleted');
      await systemDb.organization.update({
        where: { id: org.id },
        data: { deletedAt: null, purgeAfter: null },
      });
      await instanceAudit(request, {
        action: 'instance.org_restore',
        resourceType: 'organization',
        resourceId: org.id,
        metadata: { slug: org.slug },
      });
      return { slug: org.slug, deletedAt: null };
    }
  );

  fastify.put<{ Params: { slug: string } }>(
    '/api/admin/orgs/:slug/plan',
    admin,
    async (request) => {
      const { plan } = SetPlanSchema.parse(request.body);
      const org = await systemDb.organization.findFirst({
        where: { slug: request.params.slug, deletedAt: null },
      });
      if (!org) throw new NotFoundError('Organization not found');
      await systemDb.organization.update({ where: { id: org.id }, data: { plan } });
      fastify.container.plans.forget();
      await instanceAudit(request, {
        action: 'instance.org_plan',
        resourceType: 'organization',
        resourceId: org.id,
        metadata: { slug: org.slug, plan },
      });
      return { slug: org.slug, plan };
    }
  );

  // ─── Users (INST-10) ──────────────────────────────────────────────────────

  fastify.get<{ Querystring: { query?: string; cursor?: string } }>(
    '/api/admin/users',
    admin,
    async (request) => {
      const query = request.query.query?.trim();
      const now = new Date();
      const rows = await systemDb.user.findMany({
        where: {
          ...(query && {
            OR: [
              { email: { contains: query, mode: 'insensitive' } },
              { name: { contains: query, mode: 'insensitive' } },
            ],
          }),
          ...cursorWhere(request.query.cursor),
        },
        include: {
          WorkspaceMembers: {
            where: { joinedAt: { not: null } },
            include: { workspace: { select: { slug: true } } },
          },
          InstanceAdmin: true,
          _count: {
            select: { RefreshTokens: { where: { revokedAt: null, expiresAt: { gt: now } } } },
          },
        },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: PAGE,
      });
      return {
        users: rows.map((u) => ({
          id: u.id,
          email: u.email,
          name: u.name,
          lastLoginAt: u.lastLoginAt,
          createdAt: u.createdAt,
          isInstanceAdmin: !!u.InstanceAdmin && !u.InstanceAdmin.revokedAt,
          activeSessions: u._count.RefreshTokens,
          workspaces: u.WorkspaceMembers.map((m) => ({ slug: m.workspace.slug, role: m.role })),
        })),
        nextCursor: nextCursor(rows, PAGE),
      };
    }
  );

  const userById = async (id: string) => {
    const user = await systemDb.user.findUnique({ where: { id } });
    if (!user) throw new NotFoundError('User not found');
    return user;
  };

  /** Ends every session at once: refresh tokens die now, access tokens within 15 minutes. */
  fastify.post<{ Params: { id: string } }>(
    '/api/admin/users/:id/revoke-sessions',
    admin,
    async (request) => {
      const user = await userById(request.params.id);
      const { count } = await systemDb.refreshToken.updateMany({
        where: { userId: user.id, revokedAt: null },
        data: { revokedAt: new Date() },
      });
      await instanceAudit(request, {
        action: 'instance.user_sessions_revoke',
        resourceType: 'user',
        resourceId: user.id,
        metadata: { sessions: count },
      });
      return { revoked: count };
    }
  );

  /**
   * Erases a user (GDPR): the account, identities, sessions, memberships and their API
   * keys. Refused while they're the last owner of a workspace or the last admin of an
   * organization or the instance, so nothing is left without anyone in charge.
   */
  fastify.delete<{ Params: { id: string }; Querystring: { confirm?: string } }>(
    '/api/admin/users/:id',
    admin,
    async (request, reply) => {
      const user = await userById(request.params.id);
      if (request.query.confirm !== user.email) {
        throw new BadRequestError('Confirm the deletion with ?confirm=<email>');
      }
      if (user.id === request.principal!.id) {
        throw new BadRequestError('Instance admins cannot delete their own account here');
      }
      const owned = await systemDb.workspaceMember.findMany({
        where: { userId: user.id, role: 'owner' },
        include: { workspace: { select: { slug: true } } },
      });
      const lastOwnerOf: string[] = [];
      for (const m of owned) {
        const owners = await systemDb.workspaceMember.count({
          where: { workspaceId: m.workspaceId, role: 'owner', joinedAt: { not: null } },
        });
        if (owners <= 1) lastOwnerOf.push(m.workspace.slug);
      }
      const adminOf = await systemDb.organizationMember.findMany({
        where: { userId: user.id, role: 'org_admin', organization: { deletedAt: null } },
        include: { organization: { select: { slug: true } } },
      });
      const lastAdminOf: string[] = [];
      for (const m of adminOf) {
        const admins = await systemDb.organizationMember.count({
          where: { organizationId: m.organizationId, role: 'org_admin' },
        });
        if (admins <= 1) lastAdminOf.push(m.organization.slug);
      }
      if (lastOwnerOf.length || lastAdminOf.length) {
        throw new ConflictError(
          `Transfer ownership first: last owner of ${lastOwnerOf.join(', ') || 'no workspace'}, last admin of ${lastAdminOf.join(', ') || 'no organization'}`
        );
      }
      // Cascades: identities, refresh tokens, memberships, API keys, admin grant, SCIM links.
      await systemDb.user.delete({ where: { id: user.id } });
      // Pseudonymous: the id only, never the email.
      await instanceAudit(request, {
        action: 'instance.user_delete',
        resourceType: 'user',
        resourceId: user.id,
      });
      return reply.code(204).send();
    }
  );

  // ─── Instance admins (INST-05..07) ────────────────────────────────────────

  fastify.get('/api/admin/admins', admin, async () => {
    const grants = await systemDb.instanceAdmin.findMany({
      where: { revokedAt: null },
      include: { user: { select: { id: true, email: true, name: true, lastLoginAt: true } } },
      orderBy: { createdAt: 'asc' },
    });
    return {
      admins: grants.map((g) => ({ ...g.user, grantedBy: g.grantedBy, since: g.createdAt })),
    };
  });

  fastify.post('/api/admin/admins', admin, async (request, reply) => {
    const { email } = GrantInstanceAdminSchema.parse(request.body);
    const user = await systemDb.user.findUnique({ where: { email } });
    if (!user) throw new NotFoundError('No user with this email (they must sign in once first)');
    await systemDb.instanceAdmin.upsert({
      where: { userId: user.id },
      create: { userId: user.id, grantedBy: request.principal!.id },
      update: { revokedAt: null, grantedBy: request.principal!.id },
    });
    await instanceAudit(request, {
      action: 'instance.admin_grant',
      resourceType: 'user',
      resourceId: user.id,
    });
    return reply.code(201).send({ id: user.id, email: user.email });
  });

  fastify.delete<{ Params: { userId: string } }>(
    '/api/admin/admins/:userId',
    admin,
    async (request, reply) => {
      const grant = await systemDb.instanceAdmin.findFirst({
        where: { userId: request.params.userId, revokedAt: null },
      });
      if (!grant) throw new NotFoundError('Not an instance admin');
      if ((await systemDb.instanceAdmin.count({ where: { revokedAt: null } })) <= 1) {
        throw new ConflictError('The instance needs at least one admin');
      }
      await systemDb.instanceAdmin.update({
        where: { id: grant.id },
        data: { revokedAt: new Date() },
      });
      await instanceAudit(request, {
        action: 'instance.admin_revoke',
        resourceType: 'user',
        resourceId: grant.userId,
      });
      return reply.code(204).send();
    }
  );

  // ─── Instance settings (INST-11..17) ──────────────────────────────────────

  const settingKey = (key: string) => {
    if (!(INSTANCE_SETTING_KEYS as readonly string[]).includes(key)) {
      throw new NotFoundError('Unknown setting');
    }
    return key as InstanceSettingKey;
  };

  /** Every setting, secrets masked, with whether it comes from the database or the env. */
  fastify.get('/api/admin/settings', admin, async () => settings.view());

  fastify.put<{ Params: { key: string } }>('/api/admin/settings/:key', admin, async (request) => {
    const key = settingKey(request.params.key);
    const { plain, stored, fields } = settings.prepare(key, request.body);
    // INST-23: never lock the instance (or the admin saving) out of the admin panel.
    let lockedOut: string[] = [];
    if (key === 'auth') {
      const { admins } = await settings.adminSignInAfter(plain);
      if (!admins.some((a) => a.canSignIn)) {
        throw new ConflictError('No instance admin could sign in with these sign-in methods');
      }
      if (admins.some((a) => a.id === request.principal!.id && !a.canSignIn)) {
        throw new ConflictError(
          'You could no longer sign in with these sign-in methods; keep one you have used'
        );
      }
      lockedOut = admins.filter((a) => !a.canSignIn).map((a) => a.email);
    }
    // INST-11: a storage that can't write, read back and delete is never saved.
    if (key === 'storage') {
      const target = storageTargetFromSettings(plain as StorageSettings, fastify.config);
      const probe = target ? await probeStorage(target) : null;
      if (probe && !probe.ok) {
        throw new BadRequestError(`The storage test failed: ${probe.error}`);
      }
    }
    await settings.save(key, stored, request.principal!.id);
    // INST-18: the key and the changed field names, never the values.
    await instanceAudit(request, {
      action: 'instance.config_updated',
      resourceType: 'instance_config',
      resourceId: key,
      metadata: { key, fields, ...(lockedOut.length && { adminsLockedOut: lockedOut.length }) },
    });
    // Other admins who can no longer sign in, so the panel can warn about them.
    return lockedOut.length
      ? { ...settings.view()[key], adminsLockedOut: lockedOut }
      : settings.view()[key];
  });

  /** Back to the environment's defaults. */
  fastify.delete<{ Params: { key: string } }>(
    '/api/admin/settings/:key',
    admin,
    async (request, reply) => {
      const key = settingKey(request.params.key);
      if (!(await settings.reset(key))) throw new NotFoundError('Not set in the database');
      await instanceAudit(request, {
        action: 'instance.config_updated',
        resourceType: 'instance_config',
        resourceId: key,
        metadata: { key, reset: true },
      });
      return reply.code(204).send();
    }
  );

  // INST-11: Test Connection for the storage in use.
  fastify.post('/api/admin/settings/storage/test', admin, async () => {
    const target = fastify.container.instanceStorage;
    return {
      adapter: settings.storageAdapter(),
      ...(target ? await probeStorage(target) : { ok: false, latencyMs: 0, error: 'No storage' }),
    };
  });

  // INST-12: Send Test Email, to the signed-in admin.
  fastify.post('/api/admin/settings/email/test', admin, async (request) => {
    const mailer = fastify.container.mailer;
    if (!mailer) throw new BadRequestError('No email is configured');
    const user = await systemDb.user.findUniqueOrThrow({ where: { id: request.principal!.id } });
    const name = settings.branding().name;
    try {
      await mailer.send({
        to: user.email,
        subject: `${name}: test email`,
        text: `This test message from ${name} shows that outbound email works.`,
      });
    } catch (err) {
      throw new BadRequestError(`Sending failed: ${(err as Error).message}`);
    }
    return { sentTo: user.email };
  });

  // ─── Instance audit log (INST-18) ─────────────────────────────────────────

  fastify.get<{ Querystring: { format?: string; action?: string; from?: string; to?: string } }>(
    '/api/admin/audit/export',
    admin,
    async (request, reply) => {
      const q = request.query;
      const format = exportFormat(q.format);
      const where = {
        ...(q.action && { action: { startsWith: q.action } }),
        ...dateRange(q),
      };
      await instanceAudit(request, {
        action: 'instance.audit_export',
        resourceType: 'instance',
        resourceId: 'instance',
        metadata: { format, filters: { action: q.action, from: q.from, to: q.to } },
      });
      const rows = keysetRows((after, take) =>
        systemDb.instanceAuditEvent.findMany({
          where: { ...where, ...afterWhere(after) },
          orderBy: NEWEST_FIRST,
          take,
        })
      );
      return sendExport(reply, rows, { format, name: 'instance', workspaceColumn: false });
    }
  );

  /**
   * AUD-05: the audit log of a workspace, also after it was deleted (by id: the slug may be
   * reused). The id is in the `instance.workspace_delete` / `org.workspace_delete` event.
   */
  fastify.get<{
    Params: { workspaceId: string };
    Querystring: { format?: string; action?: string; from?: string; to?: string };
  }>('/api/admin/workspace-audit/:workspaceId/export', admin, async (request, reply) => {
    const { workspaceId } = request.params;
    const q = request.query;
    const format = exportFormat(q.format);
    const where = {
      workspaceId,
      ...(q.action && { action: { startsWith: q.action } }),
      ...dateRange(q),
    };
    await instanceAudit(request, {
      action: 'instance.audit_export',
      resourceType: 'workspace',
      resourceId: workspaceId,
      metadata: { format, filters: { action: q.action, from: q.from, to: q.to } },
    });
    const rows = keysetRows((after, take) =>
      systemDb.auditEvent.findMany({
        where: { ...where, ...afterWhere(after) },
        orderBy: NEWEST_FIRST,
        take,
      })
    );
    return sendExport(reply, rows, {
      format,
      name: `workspace-${workspaceId}`,
      workspaceColumn: false,
    });
  });

  /** INST-18, AUD-07/08: the instance log with readable actors; filter by action prefix,
   * actor (id or email), resource and date range. */
  fastify.get<{
    Querystring: {
      cursor?: string;
      action?: string;
      actor?: string;
      resourceId?: string;
      from?: string;
      to?: string;
    };
  }>('/api/admin/audit', admin, async (request) => {
    const q = request.query;
    const from = parseDate(q.from);
    const to = parseDate(q.to);
    const events = await systemDb.instanceAuditEvent.findMany({
      where: {
        ...cursorWhere(q.cursor),
        ...(await actorWhere(systemDb, q.actor)),
        ...(q.action && { action: { startsWith: q.action } }),
        ...(q.resourceId && { resourceId: q.resourceId }),
        ...((from || to) && { createdAt: { gte: from, lte: to } }),
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: PAGE,
    });
    const actors = await resolveActors(systemDb, events);
    return {
      events: events.map((e) => ({ ...e, actor: actorOf(actors, e) })),
      nextCursor: nextCursor(events, PAGE),
    };
  });
};

export default adminRoutes;
