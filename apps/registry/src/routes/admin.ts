// Copyright The Harmoniq Authors
// SPDX-License-Identifier: Apache-2.0

/* eslint-disable no-restricted-syntax -- MT-09: instance administration spans every tenant (INST-05) */

import { attention, trends } from '../services/overview';
import { SUPPORT_GRANT_MAX_HOURS, auditInTenant } from '../services/supportGrants';
import {
  MAINTENANCE_QUEUES,
  REPLICA_ID,
  buildInfo,
  failedJobs,
  jobQueues,
  migrationStatus,
  replicas,
  retryJob,
  runNow,
} from '../services/operations';
import { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { createHash, timingSafeEqual } from 'crypto';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
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
  UpdateInstanceAdminSchema,
  CreateInstanceApiKeySchema,
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
import { recordPlanChange } from '../services/planChanges';
import { verifyChain } from '../services/auditChain';
import { changedPaths } from '../services/instanceSettings';
import { RESEAL_QUEUE, resealAll, sealedValueReport } from '../services/reseal';
import { reportDays, sendUsageCsv, usageTotals, workspaceUsage } from '../services/usageReport';
import { actorOf, actorWhere, parseDate, resolveActors } from '../services/auditActors';
import { asAdminRole, capabilitiesOf } from '../services/adminAccess';
import { formatInstanceApiKey, generateApiKeySecret } from '../auth/apiKeys';

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

const planDto = (
  slug: string,
  p: { plan: string; planExpiresAt: Date | null; basePlan: string | null; planOverrides: unknown }
) => ({
  slug,
  plan: p.plan,
  expiresAt: p.planExpiresAt?.toISOString() ?? null,
  basePlan: p.basePlan,
  overrides: p.planOverrides ?? null,
});

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
        // INST-33: changes made with an instance key are recorded as the key's.
        actorType: request.principal!.type === 'apiKey' ? 'apiKey' : 'user',
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
  fastify.get('/api/instance', async () => {
    // INST-22/37: the banner, and maintenance (running or upcoming) for every page.
    const maintenance = settings.maintenance();
    return {
      branding: settings.branding(),
      announcement: settings.announcement(),
      maintenance: maintenance && {
        active: maintenance.active,
        from: maintenance.from ?? null,
        until: maintenance.until ?? null,
        message: maintenance.message ?? null,
      },
    };
  });

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

  // INST-26: sealed values per key scan every sealed column: kept for ten minutes.
  let encryption: { at: number; report: Awaited<ReturnType<typeof sealedValueReport>> } | null =
    null;
  const encryptionSummary = async () => {
    if (!encryption || Date.now() - encryption.at > 10 * 60_000) {
      encryption = {
        at: Date.now(),
        report: await sealedValueReport(systemDb, fastify.config.encryptionKey),
      };
    }
    const { active, stale, unknownKeys, keys } = encryption.report;
    return { active, keys: keys.length, stale, unknownKeys: unknownKeys.length };
  };

  fastify.get('/api/admin/health', admin, async () => {
    const [health, workspaces, modules, users, keys] = await Promise.all([
      instanceHealth(fastify.container, adapters()),
      systemDb.workspace.count(),
      systemDb.remoteModule.count(),
      systemDb.user.count(),
      encryptionSummary(),
    ]);
    return { ...health, stats: { workspaces, modules, users }, encryption: keys };
  });

  // ─── Overview (INST-27) ───────────────────────────────────────────────────

  /** The admin home: counts, 30-day trends, what needs attention, recent changes. */
  fastify.get('/api/admin/overview', admin, async () => {
    const [workspaces, organizations, users, modules, series, items, events] = await Promise.all([
      systemDb.workspace.count({ where: { deletedAt: null } }),
      systemDb.organization.count({ where: { deletedAt: null } }),
      systemDb.user.count(),
      systemDb.remoteModule.count(),
      trends(systemDb),
      attention(systemDb),
      systemDb.instanceAuditEvent.findMany({ orderBy: { createdAt: 'desc' }, take: 10 }),
    ]);
    const actors = await resolveActors(systemDb, events);
    return {
      counts: { workspaces, organizations, users, modules },
      trends: series,
      attention: items,
      recentAudit: events.map((e) => ({
        id: e.id,
        action: e.action,
        actor: actorOf(actors, e),
        resourceType: e.resourceType,
        resourceId: e.resourceId,
        createdAt: e.createdAt.toISOString(),
      })),
    };
  });

  // ─── Support access (INST-20) ─────────────────────────────────────────────

  /** Grants of the last 30 days, the active ones first. */
  fastify.get('/api/admin/support-grants', admin, async () => {
    const now = new Date();
    const grants = await systemDb.supportGrant.findMany({
      where: { createdAt: { gt: new Date(now.getTime() - 30 * 86_400_000) } },
      orderBy: { createdAt: 'desc' },
      take: 200,
    });
    const [users, workspaces, orgs] = await Promise.all([
      systemDb.user.findMany({
        where: { id: { in: grants.map((g) => g.adminUserId) } },
        select: { id: true, email: true },
      }),
      systemDb.workspace.findMany({
        where: { id: { in: grants.flatMap((g) => (g.workspaceId ? [g.workspaceId] : [])) } },
        select: { id: true, slug: true },
      }),
      systemDb.organization.findMany({
        where: { id: { in: grants.flatMap((g) => (g.organizationId ? [g.organizationId] : [])) } },
        select: { id: true, slug: true },
      }),
    ]);
    const label = new Map([...users.map((u) => [u.id, u.email] as const)]);
    const wsSlug = new Map(workspaces.map((w) => [w.id, w.slug]));
    const orgSlug = new Map(orgs.map((o) => [o.id, o.slug]));
    return {
      grants: grants
        .map((g) => ({
          id: g.id,
          admin: label.get(g.adminUserId) ?? 'deleted user',
          adminUserId: g.adminUserId,
          workspace: g.workspaceId ? (wsSlug.get(g.workspaceId) ?? null) : null,
          organization: g.organizationId ? (orgSlug.get(g.organizationId) ?? null) : null,
          reason: g.reason,
          expiresAt: g.expiresAt.toISOString(),
          revokedAt: g.revokedAt?.toISOString() ?? null,
          createdAt: g.createdAt.toISOString(),
          active: !g.revokedAt && g.expiresAt > now,
        }))
        .sort((a, b) => Number(b.active) - Number(a.active)),
    };
  });

  /** Opens read-only access to one workspace or organization for at most 4 hours. */
  fastify.post('/api/admin/support-grants', admin, async (request, reply) => {
    if (request.principal!.type !== 'user') {
      throw new ForbiddenError('Support access is for people, not keys');
    }
    const body = z
      .object({
        workspace: z.string().min(1).optional(),
        organization: z.string().min(1).optional(),
        reason: z.string().trim().min(10).max(500),
        hours: z.number().int().min(1).max(SUPPORT_GRANT_MAX_HOURS).default(1),
      })
      .refine((b) => !!b.workspace !== !!b.organization, 'Give a workspace or an organization')
      .parse(request.body);
    const target = body.workspace
      ? await systemDb.workspace.findFirst({ where: { slug: body.workspace, deletedAt: null } })
      : await systemDb.organization.findFirst({
          where: { slug: body.organization, deletedAt: null },
        });
    if (!target)
      throw new NotFoundError(body.workspace ? 'Workspace not found' : 'Organization not found');
    const grant = await systemDb.supportGrant.create({
      data: {
        adminUserId: request.principal!.id,
        ...(body.workspace ? { workspaceId: target.id } : { organizationId: target.id }),
        reason: body.reason,
        expiresAt: new Date(Date.now() + body.hours * 3_600_000),
      },
    });
    await instanceAudit(request, {
      action: 'instance.support_grant',
      resourceType: body.workspace ? 'workspace' : 'organization',
      resourceId: target.id,
      metadata: { grant: grant.id, slug: target.slug, reason: body.reason, hours: body.hours },
    });
    await auditInTenant(systemDb, grant, 'support.access_granted', {
      id: request.principal!.id,
      ip: request.ip,
    });
    return reply.code(201).send({
      id: grant.id,
      expiresAt: grant.expiresAt.toISOString(),
      ...(body.workspace ? { workspace: target.slug } : { organization: target.slug }),
    });
  });

  /** Ends a grant early: your own, or anyone's for instance owners. */
  fastify.delete<{ Params: { id: string } }>(
    '/api/admin/support-grants/:id',
    admin,
    async (request, reply) => {
      const grant = await systemDb.supportGrant.findUnique({ where: { id: request.params.id } });
      if (!grant) throw new NotFoundError('Support grant not found');
      const principal = request.principal!;
      const owner = principal.type === 'user' && principal.instanceRole === 'instance_owner';
      if (grant.adminUserId !== principal.id && !owner) {
        throw new ForbiddenError("Only instance owners end other admins' support access");
      }
      if (!grant.revokedAt && grant.expiresAt > new Date()) {
        const ended = await systemDb.supportGrant.update({
          where: { id: grant.id },
          data: { revokedAt: new Date(), revokedBy: principal.id },
        });
        await instanceAudit(request, {
          action: 'instance.support_revoke',
          resourceType: grant.workspaceId ? 'workspace' : 'organization',
          resourceId: (grant.workspaceId ?? grant.organizationId)!,
          metadata: { grant: grant.id },
        });
        await auditInTenant(systemDb, ended, 'support.access_revoked', {
          id: principal.id,
          ip: request.ip,
        });
      }
      return reply.code(204).send();
    }
  );

  // ─── Operations (INST-28) ─────────────────────────────────────────────────

  /** Version, commit, migrations not applied yet, and every replica's heartbeat. */
  fastify.get('/api/admin/system', admin, async () => {
    const [migrations, replicaList] = await Promise.all([
      migrationStatus(systemDb),
      replicas(systemDb),
    ]);
    return { build: buildInfo(), replica: REPLICA_ID, migrations, replicas: replicaList };
  });

  /** Each job queue: schedule, last run, last success and failure. */
  fastify.get('/api/admin/jobs', admin, async () => ({
    queueRunning: !!fastify.container.boss,
    queues: await jobQueues(systemDb),
  }));

  fastify.get<{ Querystring: { queue?: string } }>(
    '/api/admin/jobs/failed',
    admin,
    async (request) => ({ jobs: await failedJobs(systemDb, request.query.queue || undefined) })
  );

  const requireBoss = () => {
    const { boss } = fastify.container;
    if (!boss) throw new ConflictError('The job queue is not running on this registry');
    return boss;
  };

  fastify.post<{ Params: { id: string } }>('/api/admin/jobs/:id/retry', admin, async (request) => {
    const retried = await retryJob(requireBoss(), systemDb, request.params.id);
    if (!retried) throw new NotFoundError('No failed job with this id');
    await instanceAudit(request, {
      action: 'instance.job_retry',
      resourceType: 'job',
      resourceId: retried.id,
      metadata: { queue: retried.queue },
    });
    return retried;
  });

  /** Maintenance jobs only (GC, rollups, purge, domain re-check …). */
  fastify.post<{ Params: { queue: string } }>(
    '/api/admin/jobs/:queue/run',
    admin,
    async (request, reply) => {
      const { queue } = request.params;
      if (!(MAINTENANCE_QUEUES as readonly string[]).includes(queue)) {
        throw new BadRequestError(
          `Only maintenance jobs can be run: ${MAINTENANCE_QUEUES.join(', ')}`
        );
      }
      const started = await runNow(requireBoss(), queue);
      await instanceAudit(request, {
        action: 'instance.job_run',
        resourceType: 'job',
        resourceId: queue,
      });
      return reply.code(202).send(started);
    }
  );

  // ─── Workspaces (INST-09) ─────────────────────────────────────────────────

  // INST-09, INST-29: the list and detail are in adminDirectory.ts.

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

  /**
   * PLN-01, PLN-06: `{ plan, overrides?, expiresAt?, basePlan? }`. With `expiresAt` the plan
   * is a trial that falls back to `basePlan` (default: the plan before). `overrides`
   * replaces the tenant's (null clears them; omitted keeps them).
   */
  function planData(
    body: ReturnType<typeof SetPlanSchema.parse>,
    current: { plan: string; planExpiresAt: Date | null; basePlan: string | null } | null
  ) {
    const trial = body.expiresAt ?? null;
    if (trial && trial <= new Date())
      throw new BadRequestError('`expiresAt` must be in the future');
    return {
      plan: body.plan,
      planExpiresAt: trial,
      basePlan: trial
        ? (body.basePlan ?? (current?.planExpiresAt ? current.basePlan : current?.plan) ?? 'hobby')
        : null,
      ...(body.overrides !== undefined && {
        planOverrides:
          body.overrides === null ? Prisma.DbNull : (body.overrides as Prisma.InputJsonValue),
      }),
    };
  }

  /** PLN-01, PLN-06: a workspace's plan, trial and overrides (for automation). */
  fastify.get<{ Params: { slug: string } }>(
    '/api/admin/workspaces/:slug/plan',
    admin,
    async (request) => {
      const workspace = await workspaceBySlug(request.params.slug);
      const current = await systemDb.workspaceConfig.findUnique({
        where: { workspaceId: workspace.id },
      });
      return planDto(
        workspace.slug,
        current ?? { plan: 'hobby', planExpiresAt: null, basePlan: null, planOverrides: null }
      );
    }
  );

  fastify.put<{ Params: { slug: string } }>(
    '/api/admin/workspaces/:slug/plan',
    admin,
    async (request) => {
      const body = SetPlanSchema.parse(request.body);
      const workspace = await workspaceBySlug(request.params.slug);
      const current = await systemDb.workspaceConfig.findUnique({
        where: { workspaceId: workspace.id },
      });
      const data = planData(body, current);
      const saved = await systemDb.workspaceConfig.upsert({
        where: { workspaceId: workspace.id },
        create: { workspaceId: workspace.id, ...data },
        update: data,
      });
      fastify.container.plans.forget();
      const metadata = {
        slug: workspace.slug,
        plan: body.plan,
        expiresAt: data.planExpiresAt,
        basePlan: data.basePlan,
        ...(body.overrides !== undefined && { overrides: body.overrides }),
      };
      await instanceAudit(request, {
        action: 'instance.workspace_plan',
        resourceType: 'workspace',
        resourceId: workspace.id,
        metadata,
      });
      // USG-04
      await recordPlanChange(
        fastify.container,
        { workspaceId: workspace.id },
        {
          from: current?.plan ?? 'hobby',
          to: body.plan,
          reason: 'admin',
          expiresAt: data.planExpiresAt,
          overrides: body.overrides,
        },
        { type: 'user', id: request.principal!.id }
      );
      return planDto(workspace.slug, saved);
    }
  );

  // INST-19: the list and detail are in adminDirectory.ts.

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

  fastify.get<{ Params: { slug: string } }>(
    '/api/admin/orgs/:slug/plan',
    admin,
    async (request) => {
      const org = await systemDb.organization.findFirst({
        where: { slug: request.params.slug, deletedAt: null },
      });
      if (!org) throw new NotFoundError('Organization not found');
      return planDto(org.slug, org);
    }
  );

  fastify.put<{ Params: { slug: string } }>(
    '/api/admin/orgs/:slug/plan',
    admin,
    async (request) => {
      const body = SetPlanSchema.parse(request.body);
      const org = await systemDb.organization.findFirst({
        where: { slug: request.params.slug, deletedAt: null },
      });
      if (!org) throw new NotFoundError('Organization not found');
      const data = planData(body, org);
      const saved = await systemDb.organization.update({ where: { id: org.id }, data });
      fastify.container.plans.forget();
      await instanceAudit(request, {
        action: 'instance.org_plan',
        resourceType: 'organization',
        resourceId: org.id,
        metadata: {
          slug: org.slug,
          plan: body.plan,
          expiresAt: data.planExpiresAt,
          basePlan: data.basePlan,
          ...(body.overrides !== undefined && { overrides: body.overrides }),
        },
      });
      await recordPlanChange(
        fastify.container,
        { organizationId: org.id },
        {
          from: org.plan,
          to: body.plan,
          reason: 'admin',
          expiresAt: data.planExpiresAt,
          overrides: body.overrides,
        },
        { type: 'user', id: request.principal!.id }
      );
      return planDto(org.slug, saved);
    }
  );

  // ─── Usage (USG-03, INST-09) ──────────────────────────────────────────────

  /** Every live workspace's usage against its quotas, a page at a time (or all as CSV). */
  fastify.get<{ Querystring: { days?: string; format?: string; cursor?: string } }>(
    '/api/admin/usage',
    admin,
    async (request, reply) => {
      const days = reportDays(request.query.days);
      const csv = request.query.format === 'csv';
      const rows = await systemDb.workspace.findMany({
        where: { deletedAt: null, ...(!csv && cursorWhere(request.query.cursor)) },
        select: { id: true, slug: true, name: true, createdAt: true },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        ...(!csv && { take: PAGE }),
      });
      const { plans, quotas } = fastify.container;
      const usage = await workspaceUsage({ plans, quotas }, systemDb, rows, days);
      if (csv) return sendUsageCsv(reply, 'instance', usage);
      return {
        days,
        totals: usageTotals(usage),
        workspaces: usage,
        nextCursor: nextCursor(rows, PAGE),
      };
    }
  );

  // ─── Users (INST-10) ──────────────────────────────────────────────────────

  // INST-10, INST-30: the list and detail are in adminDirectory.ts.

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
   * SES-04: suspends a user: sign-in and refresh are refused, live access tokens stop at
   * once and the API keys they created stop working, until unsuspended. Not yourself, nor
   * the last active instance admin.
   */
  fastify.post<{ Params: { id: string }; Body: { reason?: string } }>(
    '/api/admin/users/:id/suspend',
    admin,
    async (request) => {
      const user = await userById(request.params.id);
      if (user.id === request.principal!.id) {
        throw new BadRequestError('Instance admins cannot suspend themselves');
      }
      const reason =
        String(request.body?.reason ?? '')
          .trim()
          .slice(0, 500) || null;
      const grant = await systemDb.instanceAdmin.findUnique({ where: { userId: user.id } });
      if (grant && !grant.revokedAt) {
        const others = await systemDb.instanceAdmin.count({
          where: { revokedAt: null, userId: { not: user.id }, user: { suspendedAt: null } },
        });
        if (!others) throw new ConflictError('The last active instance admin cannot be suspended');
      }
      await systemDb.user.update({
        where: { id: user.id },
        data: { suspendedAt: user.suspendedAt ?? new Date(), suspendedReason: reason },
      });
      const { count } = await systemDb.refreshToken.updateMany({
        where: { userId: user.id, revokedAt: null },
        data: { revokedAt: new Date() },
      });
      fastify.forgetApiKeys();
      await instanceAudit(request, {
        action: 'instance.user_suspend',
        resourceType: 'user',
        resourceId: user.id,
        metadata: { reason, sessions: count },
      });
      return { id: user.id, suspendedAt: (user.suspendedAt ?? new Date()).toISOString(), reason };
    }
  );

  fastify.post<{ Params: { id: string } }>(
    '/api/admin/users/:id/unsuspend',
    admin,
    async (request) => {
      const user = await userById(request.params.id);
      if (!user.suspendedAt) throw new ConflictError('The user is not suspended');
      await systemDb.user.update({
        where: { id: user.id },
        data: { suspendedAt: null, suspendedReason: null },
      });
      fastify.forgetApiKeys();
      await instanceAudit(request, {
        action: 'instance.user_unsuspend',
        resourceType: 'user',
        resourceId: user.id,
      });
      return { id: user.id, suspendedAt: null };
    }
  );

  /**
   * SES-03: turns a user's MFA off (lost device and recovery codes). Their sessions end;
   * they sign in with one factor and can enrol again.
   */
  fastify.delete<{ Params: { id: string } }>(
    '/api/admin/users/:id/mfa',
    admin,
    async (request, reply) => {
      const user = await userById(request.params.id);
      if (!user.mfaEnabledAt && !user.mfaSecretSealed) {
        throw new ConflictError('The user has no MFA');
      }
      await systemDb.user.update({
        where: { id: user.id },
        data: {
          mfaEnabledAt: null,
          mfaSecretSealed: null,
          mfaRecoveryCodes: [],
          mfaLastStep: null,
        },
      });
      await systemDb.refreshToken.updateMany({
        where: { userId: user.id, revokedAt: null },
        data: { revokedAt: new Date() },
      });
      await instanceAudit(request, {
        action: 'instance.user_mfa_reset',
        resourceType: 'user',
        resourceId: user.id,
      });
      return reply.code(204).send();
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

  /** INST-31: one active, unsuspended instance owner must remain. */
  const assertOwnerRemains = async (losing: string) => {
    const owners = await systemDb.instanceAdmin.count({
      where: {
        revokedAt: null,
        role: 'instance_owner',
        userId: { not: losing },
        user: { suspendedAt: null },
      },
    });
    if (!owners) throw new ConflictError('The instance needs at least one instance owner');
  };

  fastify.get('/api/admin/admins', admin, async () => {
    const [grants, invitations] = await Promise.all([
      systemDb.instanceAdmin.findMany({
        where: { revokedAt: null },
        include: {
          user: {
            select: { id: true, email: true, name: true, lastLoginAt: true, mfaEnabledAt: true },
          },
        },
        orderBy: { createdAt: 'asc' },
      }),
      systemDb.instanceAdminInvitation.findMany({
        where: { acceptedAt: null, revokedAt: null, expiresAt: { gt: new Date() } },
        orderBy: { createdAt: 'asc' },
      }),
    ]);
    return {
      admins: grants.map((g) => ({
        id: g.user.id,
        email: g.user.email,
        name: g.user.name,
        lastLoginAt: g.user.lastLoginAt,
        mfa: !!g.user.mfaEnabledAt,
        role: asAdminRole(g.role),
        capabilities: capabilitiesOf(asAdminRole(g.role)),
        grantedBy: g.grantedBy,
        since: g.createdAt,
      })),
      invitations: invitations.map((i) => ({
        id: i.id,
        email: i.email,
        role: i.role,
        expiresAt: i.expiresAt,
        createdAt: i.createdAt,
      })),
    };
  });

  /**
   * INST-31: grants a role to an existing account, or invites an email that hasn't signed
   * in yet (their first sign-in with it, not through a tenant's SSO, accepts within 7 days).
   */
  fastify.post('/api/admin/admins', admin, async (request, reply) => {
    const { email, role } = GrantInstanceAdminSchema.parse(request.body);
    const user = await systemDb.user.findUnique({ where: { email } });
    if (!user) {
      await systemDb.instanceAdminInvitation.updateMany({
        where: { email, acceptedAt: null, revokedAt: null },
        data: { revokedAt: new Date() },
      });
      const invitation = await systemDb.instanceAdminInvitation.create({
        data: {
          email,
          role,
          invitedBy: request.principal!.id,
          expiresAt: new Date(Date.now() + 7 * 86_400_000),
        },
      });
      await instanceAudit(request, {
        action: 'instance.admin_invite',
        resourceType: 'admin_invitation',
        resourceId: invitation.id,
        metadata: { role },
      });
      return reply.code(202).send({ invited: true, id: invitation.id, email, role });
    }
    const current = await systemDb.instanceAdmin.findUnique({ where: { userId: user.id } });
    if (
      current &&
      !current.revokedAt &&
      current.role === 'instance_owner' &&
      role !== 'instance_owner'
    ) {
      await assertOwnerRemains(user.id);
    }
    await systemDb.instanceAdmin.upsert({
      where: { userId: user.id },
      create: { userId: user.id, role, grantedBy: request.principal!.id },
      update: { revokedAt: null, role, grantedBy: request.principal!.id },
    });
    await instanceAudit(request, {
      action: 'instance.admin_grant',
      resourceType: 'user',
      resourceId: user.id,
      metadata: { role },
    });
    return reply.code(201).send({ id: user.id, email: user.email, role });
  });

  fastify.patch<{ Params: { userId: string } }>(
    '/api/admin/admins/:userId',
    admin,
    async (request) => {
      const { role } = UpdateInstanceAdminSchema.parse(request.body);
      const grant = await systemDb.instanceAdmin.findFirst({
        where: { userId: request.params.userId, revokedAt: null },
      });
      if (!grant) throw new NotFoundError('Not an instance admin');
      if (grant.role === 'instance_owner' && role !== 'instance_owner') {
        await assertOwnerRemains(grant.userId);
      }
      await systemDb.instanceAdmin.update({ where: { id: grant.id }, data: { role } });
      await instanceAudit(request, {
        action: 'instance.admin_role',
        resourceType: 'user',
        resourceId: grant.userId,
        metadata: { from: grant.role, to: role },
      });
      return { id: grant.userId, role };
    }
  );

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
      if (grant.role === 'instance_owner') await assertOwnerRemains(grant.userId);
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

  fastify.delete<{ Params: { id: string } }>(
    '/api/admin/admin-invitations/:id',
    admin,
    async (request, reply) => {
      const { count } = await systemDb.instanceAdminInvitation.updateMany({
        where: { id: request.params.id, acceptedAt: null, revokedAt: null },
        data: { revokedAt: new Date() },
      });
      if (!count) throw new NotFoundError('Invitation not found');
      await instanceAudit(request, {
        action: 'instance.admin_invite_revoke',
        resourceType: 'admin_invitation',
        resourceId: request.params.id,
      });
      return reply.code(204).send();
    }
  );

  // ─── Instance API keys (INST-33) ──────────────────────────────────────────

  fastify.get('/api/admin/api-keys', admin, async () => {
    const keys = await systemDb.instanceApiKey.findMany({ orderBy: { createdAt: 'desc' } });
    return {
      keys: keys.map((k) => ({
        id: k.id,
        name: k.name,
        prefix: k.prefix,
        scopes: k.scopes,
        expiresAt: k.expiresAt,
        lastUsedAt: k.lastUsedAt,
        createdBy: k.createdBy,
        createdAt: k.createdAt,
        revokedAt: k.revokedAt,
      })),
    };
  });

  fastify.post('/api/admin/api-keys', admin, async (request, reply) => {
    const body = CreateInstanceApiKeySchema.parse(request.body);
    const { secret, keyHash } = await generateApiKeySecret();
    const created = await systemDb.instanceApiKey.create({
      data: {
        name: body.name,
        keyHash,
        prefix: 'pending',
        scopes: body.scopes,
        expiresAt: body.expiresAt,
        createdBy: request.principal!.id,
      },
    });
    const record = await systemDb.instanceApiKey.update({
      where: { id: created.id },
      data: { prefix: `hq_inst_${created.id.slice(0, 8)}` },
    });
    await instanceAudit(request, {
      action: 'instance.api_key_create',
      resourceType: 'instance_api_key',
      resourceId: record.id,
      metadata: { name: body.name, scopes: body.scopes },
    });
    // Shown once.
    return reply.code(201).send({
      id: record.id,
      name: record.name,
      prefix: record.prefix,
      scopes: record.scopes,
      key: formatInstanceApiKey(record.id, secret),
    });
  });

  fastify.delete<{ Params: { id: string } }>(
    '/api/admin/api-keys/:id',
    admin,
    async (request, reply) => {
      const { count } = await systemDb.instanceApiKey.updateMany({
        where: { id: request.params.id, revokedAt: null },
        data: { revokedAt: new Date() },
      });
      if (!count) throw new NotFoundError('Key not found');
      fastify.forgetApiKey(request.params.id);
      await instanceAudit(request, {
        action: 'instance.api_key_revoke',
        resourceType: 'instance_api_key',
        resourceId: request.params.id,
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

  /**
   * Validates and saves one setting: the lockout guard for `auth` (INST-23), the storage
   * test (INST-11), a version (INST-35) and an audit event with the changed field names.
   */
  async function applySetting(
    request: FastifyRequest,
    key: InstanceSettingKey,
    input: unknown,
    source: 'save' | 'restore' | 'import' = 'save'
  ) {
    const { plain, stored, fields } = settings.prepare(key, input);
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
    await settings.save(key, stored, request.principal!.id, source);
    // INST-18: the key and the changed field names, never the values.
    await instanceAudit(request, {
      action: 'instance.config_updated',
      resourceType: 'instance_config',
      resourceId: key,
      metadata: {
        key,
        fields,
        ...(source !== 'save' && { source }),
        ...(lockedOut.length && { adminsLockedOut: lockedOut.length }),
      },
    });
    return { lockedOut };
  }

  fastify.put<{ Params: { key: string } }>('/api/admin/settings/:key', admin, async (request) => {
    const key = settingKey(request.params.key);
    const { lockedOut } = await applySetting(request, key, request.body);
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
      if (!(await settings.reset(key, request.principal!.id))) {
        throw new NotFoundError('Not set in the database');
      }
      await instanceAudit(request, {
        action: 'instance.config_updated',
        resourceType: 'instance_config',
        resourceId: key,
        metadata: { key, reset: true },
      });
      return reply.code(204).send();
    }
  );

  // ─── Settings history, export and import (INST-35) ────────────────────────

  fastify.get<{ Params: { key: string } }>(
    '/api/admin/settings/:key/history',
    admin,
    async (request) => {
      const key = settingKey(request.params.key);
      return { key, versions: await settings.history(key) };
    }
  );

  /** Saves an older version again (as a new version), with the usual checks. */
  fastify.post<{ Params: { key: string; version: string } }>(
    '/api/admin/settings/:key/history/:version/restore',
    admin,
    async (request) => {
      const key = settingKey(request.params.key);
      const found = await settings.savedVersion(key, Number(request.params.version));
      if (!found) throw new NotFoundError('No such version');
      if (found.source === 'reset') {
        await settings.reset(key, request.principal!.id);
      } else {
        await applySetting(
          request,
          key,
          settings.openStored(key, found.value as Record<string, unknown>),
          'restore'
        );
      }
      return settings.view()[key];
    }
  );

  /** Every setting stored in the database, secrets left out, as YAML. */
  fastify.get('/api/admin/settings/export', admin, async (request, reply) => {
    await instanceAudit(request, {
      action: 'instance.config_export',
      resourceType: 'instance',
      resourceId: 'instance',
    });
    return reply
      .header('Content-Type', 'application/yaml; charset=utf-8')
      .header(
        'Content-Disposition',
        `attachment; filename="harmoniq-settings-${new Date().toISOString().slice(0, 10)}.yaml"`
      )
      .send(settings.exportYaml());
  });

  /**
   * Applies an export (`{ yaml, dryRun }`): each setting it holds is validated as a save
   * would be (secrets left out keep the stored ones). A dry run only reports the changes.
   */
  fastify.put('/api/admin/settings/import', admin, async (request) => {
    const body = z
      .object({ yaml: z.string().min(1).max(1_000_000), dryRun: z.boolean().default(true) })
      .parse(request.body);
    const incoming = settings.parseImport(body.yaml);
    const view = settings.view();
    const plan = (Object.keys(incoming) as InstanceSettingKey[]).map((key) => {
      const { plain } = settings.prepare(key, incoming[key]);
      const current = view[key].source === 'database' ? view[key].value : {};
      return {
        key,
        changed: changedPaths(
          settings.withoutSecrets(key, current as Record<string, unknown>),
          settings.withoutSecrets(key, plain)
        ),
      };
    });
    if (!body.dryRun) {
      for (const { key, changed } of plan) {
        if (changed.length) await applySetting(request, key, incoming[key], 'import');
      }
    }
    return { dryRun: body.dryRun, settings: plan };
  });

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
        template: 'test',
        to: user.email,
        subject: `${name}: test email`,
        text: `This test message from ${name} shows that outbound email works.`,
      });
    } catch (err) {
      throw new BadRequestError(`Sending failed: ${(err as Error).message}`);
    }
    return { sentTo: user.email };
  });

  // ─── Encryption keys (INST-26) ────────────────────────────────────────────

  fastify.get('/api/admin/encryption', admin, async () =>
    sealedValueReport(systemDb, fastify.config.encryptionKey)
  );

  /** Re-seals every value with the active key (queued; inline without a job queue). */
  fastify.post('/api/admin/encryption/reseal', admin, async (request, reply) => {
    await instanceAudit(request, {
      action: 'instance.secrets_reseal',
      resourceType: 'instance',
      resourceId: 'instance',
    });
    const { boss } = fastify.container;
    if (boss) {
      await boss.send(RESEAL_QUEUE, {}, { singletonKey: 'reseal' });
      return reply.code(202).send({ queued: true });
    }
    return { queued: false, ...(await resealAll(systemDb, fastify.config.encryptionKey)) };
  });

  // ─── Instance audit log (INST-18) ─────────────────────────────────────────

  /** AUD-09: checks the instance audit chain. */
  fastify.get('/api/admin/audit/verify', admin, async () =>
    verifyChain(systemDb, { kind: 'instance' })
  );

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
      events: events.map((e) => ({
        ...e,
        chainSeq: e.chainSeq?.toString() ?? null,
        actor: actorOf(actors, e),
      })),
      nextCursor: nextCursor(events, PAGE),
    };
  });
};

export default adminRoutes;
