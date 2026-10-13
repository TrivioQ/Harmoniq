// Copyright The Harmoniq Authors
// SPDX-License-Identifier: Apache-2.0

import { activeGrantsOn } from '../services/supportGrants';
import { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { Prisma } from '@prisma/client';
import type { Environment } from '@prisma/client';
import {
  BadRequestError,
  ConflictError,
  ForbiddenError,
  NotFoundError,
} from '@harmoniq/core/dist/errors/AppError';
import { findDependencyConflicts } from '@harmoniq/core/dist/manifest/dependencies';
import { environmentMatrix } from '../services/dependencyGate';
import {
  CreateEnvironmentSchema,
  CreateHostAppSchema,
  CreateWorkspaceSchema,
  UpdateEnvironmentSchema,
  UpdateHostAppSchema,
  UpdateWorkspaceSchema,
} from '@harmoniq/core/dist/schemas/ResourceSchemas';
import {
  FreezeOverrideRequestSchema,
  FreezeRequestSchema,
} from '@harmoniq/core/dist/schemas/RollbackRequestSchema';
import { audit } from '../services/audit';
import { assertRetention, orgPolicyFor } from '../services/policy';
import { createWorkspace } from '../services/workspaces';
import { assertMayCreateTenant } from '../services/tenancyPolicy';
import { restoreWorkspace, softDeleteWorkspace } from '../services/tenantLifecycle';
import { ssoScope } from '../plugins/authenticate';
import { isFrozen } from '../services/manifestMutation';
import { publishedPaths } from '../services/manifestPublisher';
import { invalidateDefaultHost, invalidateManifest } from '../services/cacheKeys';

type WsParams = { workspaceSlug: string };
type EnvParams = WsParams & { hostAppSlug: string; envSlug: string };

const titleCase = (slug: string) => slug.charAt(0).toUpperCase() + slug.slice(1).replace(/-/g, ' ');

const hostAppRoutes: FastifyPluginAsync = async (fastify) => {
  // eslint-disable-next-line no-restricted-syntax -- MT-09: creates new tenants (POST /api/workspaces)
  const { systemDb, withTenant, webhooks, publisher } = fastify.container;
  const actor = (request: FastifyRequest) => ({ principal: request.principal!, ip: request.ip });

  // ─── Workspaces ───────────────────────────────────────────────────────────

  // Any signed-in user can create a workspace and becomes its owner. API keys cannot.
  fastify.post('/api/workspaces', { preHandler: fastify.authenticate }, async (request, reply) => {
    const principal = request.principal!;
    if (principal.type !== 'user') throw new ForbiddenError('Workspaces are created by users');
    if (ssoScope(principal)) {
      throw new ForbiddenError(
        'Sign in another way to create workspaces (this session is limited to its SSO workspace)'
      );
    }
    const body = CreateWorkspaceSchema.parse(request.body);
    await assertMayCreateTenant(fastify.container, principal, 'workspace');
    const workspace = await createWorkspace(
      // eslint-disable-next-line no-restricted-syntax -- MT-09: creates a new tenant
      systemDb,
      { ...body, retentionDays: fastify.container.settings.gc().defaultRetentionDays },
      { userId: principal.id, ip: request.ip },
      fastify.container.cache
    );
    return reply.code(201).send({ slug: workspace.slug, name: workspace.name });
  });

  fastify.get<{ Params: WsParams }>(
    '/api/workspaces/:workspaceSlug',
    { preHandler: fastify.requireWorkspace('workspace:read') },
    async (request) => {
      const workspace = request.workspace!;
      const publishTarget = await publisher.targetFor(workspace.id);
      const entitlements = await fastify.container.plans.forWorkspace({ id: workspace.id });
      const hostApps = await withTenant(workspace.id, (tx) =>
        tx.hostApp.findMany({
          orderBy: [{ isDefault: 'desc' }, { slug: 'asc' }],
          include: {
            Environments: { orderBy: { slug: 'asc' } },
            _count: { select: { RemoteModules: true } },
          },
        })
      );
      return {
        slug: workspace.slug,
        name: workspace.name,
        retentionDays: workspace.retentionDays,
        allowEphemeralEnvironments: workspace.allowEphemeralEnvironments,
        // INST-09: changes are refused while suspended.
        suspendedAt: workspace.suspendedAt,
        suspendedReason: workspace.suspendedReason,
        // PLN-01..03: what the workspace's plan allows (everything when not enforced).
        plan: entitlements.plan,
        features: entitlements.features,
        // PLN-04: quotas (null: unlimited).
        limits: entitlements.limits,
        role: request.workspaceRole ?? null,
        // TLC-05: org admins may manage owners even when they aren't owners themselves.
        viaOrgAdmin: request.viaOrgAdmin ?? false,
        // INST-20: an instance admin reading through their support grant (read-only).
        support: !!request.supportGrant,
        // INST-20: instance admins with support access right now (on it or its org).
        // eslint-disable-next-line no-restricted-syntax -- MT-09: grants are instance rows
        supportAccess: await activeGrantsOn(fastify.container.systemDb, {
          workspaceId: workspace.id,
          organizationId: workspace.organizationId,
        }),
        hostApps: hostApps.map((h) => ({
          slug: h.slug,
          name: h.name,
          description: h.description,
          isDefault: h.isDefault,
          previewUrlTemplate: h.previewUrlTemplate,
          sharedDependencies: h.sharedDependencies,
          strictExposes: h.strictExposes,
          moduleCount: h._count.RemoteModules,
          environments: h.Environments.map((e) => ({
            slug: e.slug,
            name: e.name,
            isDefault: e.isDefault,
            ephemeral: e.ephemeral,
            expiresAt: e.expiresAt?.toISOString() ?? null,
            frozen: isFrozen(e),
            freezeReason: isFrozen(e) ? e.freezeReason : null,
            freezeUntil: isFrozen(e) ? (e.freezeUntil?.toISOString() ?? null) : null,
            frozenBy: isFrozen(e) ? e.frozenBy : null,
            freezeOverride: isFrozen(e) ? overrideOf(e) : null,
            // ENV-FRZ-04: a freeze window that hasn't started yet.
            scheduledFreeze:
              e.frozenAt && e.freezeFrom && e.freezeFrom > new Date()
                ? {
                    from: e.freezeFrom.toISOString(),
                    until: e.freezeUntil?.toISOString() ?? null,
                    reason: e.freezeReason,
                  }
                : null,
            // M2.1: where hosts can read this environment without the registry.
            published: publishTarget && {
              manifestUrl: publishTarget.publicUrl(
                publishTarget.prefix + publishedPaths(workspace.slug, h.slug, e.slug).manifest
              ),
              importMapUrl: publishTarget.publicUrl(
                publishTarget.prefix + publishedPaths(workspace.slug, h.slug, e.slug).importMap
              ),
              etag: e.lastPublishedEtag,
              at: e.lastPublishedAt?.toISOString() ?? null,
              error: e.lastPublishError,
            },
          })),
        })),
      };
    }
  );

  /**
   * TLC-01/02: an owner deletes the workspace (`?confirm=<slug>`). It can be restored by an
   * owner or an org admin for HARMONIQ_TENANT_RESTORE_DAYS, then it is purged.
   */
  fastify.delete<{ Params: WsParams; Querystring: { confirm?: string } }>(
    '/api/workspaces/:workspaceSlug',
    { preHandler: fastify.requireWorkspace('workspace:owner') },
    async (request, reply) => {
      const workspace = request.workspace!;
      if (request.principal!.type !== 'user') {
        throw new ForbiddenError(
          'Workspaces are deleted by people (or with an org key through the organization)'
        );
      }
      if (request.query.confirm !== workspace.slug) {
        throw new BadRequestError('Confirm the deletion with ?confirm=<workspace slug>');
      }
      // Recorded first: the workspace's own log is where its owners look.
      await withTenant(workspace.id, (tx) =>
        audit(
          tx,
          workspace.id,
          { principal: request.principal!, ip: request.ip },
          {
            action: 'workspace.delete',
            resourceType: 'workspace',
            resourceId: workspace.id,
            metadata: { restoreDays: fastify.config.tenantRestoreDays },
          }
        )
      );
      await softDeleteWorkspace(
        fastify.container,
        workspace,
        { type: 'user', id: request.principal!.id },
        fastify.config.tenantRestoreDays
      );
      return reply.code(204).send();
    }
  );

  /** TLC-02: undoes a deletion before the purge (owners and org admins). */
  fastify.post<{ Params: WsParams }>(
    '/api/workspaces/:workspaceSlug/restore',
    { preHandler: fastify.requireWorkspace('workspace:admin', { allowDeleted: true }) },
    async (request) => {
      const workspace = request.workspace!;
      if (request.workspaceRole !== 'owner' && !request.viaOrgAdmin) {
        throw new ForbiddenError('Only owners and organization admins can restore a workspace');
      }
      if (!workspace.deletedAt) throw new ConflictError('The workspace is not deleted');
      await restoreWorkspace(fastify.container, workspace);
      await withTenant(workspace.id, (tx) =>
        audit(
          tx,
          workspace.id,
          { principal: request.principal!, ip: request.ip },
          { action: 'workspace.restore', resourceType: 'workspace', resourceId: workspace.id }
        )
      );
      if (workspace.organizationId) {
        await fastify.container.orgEvents.emit(workspace.organizationId, 'org.workspace.restored', {
          workspace: workspace.slug,
          workspaceId: workspace.id,
        });
      }
      return { slug: workspace.slug, deletedAt: null };
    }
  );

  fastify.patch<{ Params: WsParams }>(
    '/api/workspaces/:workspaceSlug',
    { preHandler: fastify.requireWorkspace('workspace:admin') },
    async (request) => {
      const body = UpdateWorkspaceSchema.parse(request.body);
      const workspace = request.workspace!;
      const updated = await withTenant(workspace.id, async (tx) => {
        if (body.retentionDays !== undefined) {
          assertRetention(await orgPolicyFor(tx, workspace.organizationId), body.retentionDays);
        }
        const ws = await tx.workspace.update({ where: { id: workspace.id }, data: body });
        await audit(tx, workspace.id, actor(request), {
          action: 'workspace.update',
          resourceType: 'workspace',
          resourceId: workspace.id,
          metadata: body,
        });
        return ws;
      });
      return {
        slug: updated.slug,
        name: updated.name,
        retentionDays: updated.retentionDays,
        allowEphemeralEnvironments: updated.allowEphemeralEnvironments,
      };
    }
  );

  // ─── Host apps & environments ─────────────────────────────────────────────

  fastify.patch<{ Params: WsParams & { hostAppSlug: string } }>(
    '/api/workspaces/:workspaceSlug/host-apps/:hostAppSlug',
    { preHandler: fastify.requireWorkspace('workspace:admin') },
    async (request) => {
      const body = UpdateHostAppSchema.parse(request.body);
      const invalid = findDependencyConflicts(
        { name: 'host', dependencies: body.sharedDependencies },
        []
      );
      if (invalid.length) {
        throw new BadRequestError(
          `Invalid semver range for ${invalid.map((c) => c.package).join(', ')}`
        );
      }
      const workspace = request.workspace!;
      return withTenant(workspace.id, async (tx) => {
        const hostApp = await tx.hostApp.findUnique({
          where: {
            workspaceId_slug: { workspaceId: workspace.id, slug: request.params.hostAppSlug },
          },
        });
        if (!hostApp) throw new NotFoundError('Host app not found');
        const { sharedDependencies, ...rest } = body;
        const updated = await tx.hostApp.update({
          where: { id: hostApp.id },
          data: {
            ...rest,
            ...(sharedDependencies !== undefined && {
              sharedDependencies: sharedDependencies ?? Prisma.DbNull,
            }),
          },
        });
        await audit(tx, workspace.id, actor(request), {
          action: 'hostApp.update',
          resourceType: 'hostApp',
          resourceId: hostApp.id,
          metadata: body,
        });
        return {
          slug: updated.slug,
          name: updated.name,
          description: updated.description,
          previewUrlTemplate: updated.previewUrlTemplate,
          sharedDependencies: updated.sharedDependencies,
          strictExposes: updated.strictExposes,
        };
      });
    }
  );

  fastify.post<{ Params: WsParams }>(
    '/api/workspaces/:workspaceSlug/host-apps',
    { preHandler: fastify.requireWorkspace('workspace:admin') },
    async (request, reply) => {
      const body = CreateHostAppSchema.parse(request.body);
      const workspace = request.workspace!;
      const hostApp = await withTenant(workspace.id, async (tx) => {
        const exists = await tx.hostApp.findUnique({
          where: { workspaceId_slug: { workspaceId: workspace.id, slug: body.slug } },
        });
        if (exists) throw new ConflictError(`Host app "${body.slug}" already exists`);
        const isFirst = (await tx.hostApp.count()) === 0;
        const created = await tx.hostApp.create({
          data: {
            workspaceId: workspace.id,
            name: body.name,
            slug: body.slug,
            description: body.description,
            isDefault: isFirst,
            Environments: {
              create: body.environments.map((slug) => ({ slug, name: titleCase(slug) })),
            },
          },
        });
        await audit(tx, workspace.id, actor(request), {
          action: 'hostApp.create',
          resourceType: 'hostApp',
          resourceId: created.id,
          metadata: { slug: created.slug, environments: body.environments },
        });
        return created;
      });
      // The first host app becomes the default; drop any cached "not found" for it too.
      await invalidateDefaultHost(fastify.container.cache, workspace.slug);
      for (const env of body.environments) {
        await invalidateManifest(fastify.container.cache, workspace.slug, hostApp.slug, env);
      }
      return reply.code(201).send({ slug: hostApp.slug, name: hostApp.name });
    }
  );

  fastify.post<{ Params: WsParams & { hostAppSlug: string } }>(
    '/api/workspaces/:workspaceSlug/host-apps/:hostAppSlug/environments',
    { preHandler: fastify.requireWorkspace('workspace:admin') },
    async (request, reply) => {
      const body = CreateEnvironmentSchema.parse(request.body);
      const workspace = request.workspace!;
      const env = await withTenant(workspace.id, async (tx) => {
        const hostApp = await tx.hostApp.findUnique({
          where: {
            workspaceId_slug: { workspaceId: workspace.id, slug: request.params.hostAppSlug },
          },
        });
        if (!hostApp) throw new NotFoundError('Host app not found');
        const exists = await tx.environment.findUnique({
          where: { hostAppId_slug: { hostAppId: hostApp.id, slug: body.slug } },
        });
        if (exists) throw new ConflictError(`Environment "${body.slug}" already exists`);
        // PLN-04 (preview environments, which expire, don't count against it).
        await fastify.container.quotas.require(
          { workspaceId: workspace.id, hostAppId: hostApp.id },
          'environmentsPerHostApp'
        );
        const created = await tx.environment.create({
          data: { hostAppId: hostApp.id, name: body.name, slug: body.slug },
        });
        await audit(tx, workspace.id, actor(request), {
          action: 'environment.create',
          resourceType: 'environment',
          resourceId: created.id,
          metadata: { hostApp: hostApp.slug, slug: created.slug },
        });
        return created;
      });
      // A request just before this may have cached "not found" for the new environment.
      await invalidateManifest(
        fastify.container.cache,
        workspace.slug,
        request.params.hostAppSlug,
        env.slug
      );
      return reply.code(201).send({ slug: env.slug, name: env.name });
    }
  );

  // IaC-02: deletes refuse while anything is live (active or canary versions), as
  // `harmoniq apply --prune` does; the history goes with the resource.
  const LIVE = { status: { in: ['active' as const, 'canary' as const] }, deletedAt: null };

  fastify.delete<{ Params: WsParams & { hostAppSlug: string } }>(
    '/api/workspaces/:workspaceSlug/host-apps/:hostAppSlug',
    { preHandler: fastify.requireWorkspace('workspace:admin') },
    async (request, reply) => {
      const workspace = request.workspace!;
      await withTenant(workspace.id, async (tx) => {
        const hostApp = await tx.hostApp.findUnique({
          where: {
            workspaceId_slug: { workspaceId: workspace.id, slug: request.params.hostAppSlug },
          },
        });
        if (!hostApp) throw new NotFoundError('Host app not found');
        if (
          await tx.moduleVersion.count({
            where: { environment: { hostAppId: hostApp.id }, ...LIVE },
          })
        ) {
          throw new ConflictError(`"${hostApp.slug}" still serves module versions`);
        }
        if (hostApp.isDefault && (await tx.hostApp.count()) > 1) {
          throw new ConflictError('Make another host app the default before deleting this one');
        }
        await tx.hostApp.delete({ where: { id: hostApp.id } });
        await audit(tx, workspace.id, actor(request), {
          action: 'hostApp.delete',
          resourceType: 'hostApp',
          resourceId: hostApp.id,
          metadata: { slug: hostApp.slug },
        });
      });
      await invalidateDefaultHost(fastify.container.cache, workspace.slug);
      return reply.code(204).send();
    }
  );

  async function findEnvironment(
    tx: Prisma.TransactionClient,
    workspaceId: string,
    params: EnvParams
  ) {
    const hostApp = await tx.hostApp.findUnique({
      where: { workspaceId_slug: { workspaceId, slug: params.hostAppSlug } },
    });
    const env =
      hostApp &&
      (await tx.environment.findUnique({
        where: { hostAppId_slug: { hostAppId: hostApp.id, slug: params.envSlug } },
      }));
    if (!hostApp || !env) throw new NotFoundError('Environment not found');
    return { hostApp, env };
  }

  fastify.patch<{ Params: EnvParams }>(
    '/api/workspaces/:workspaceSlug/host-apps/:hostAppSlug/environments/:envSlug',
    { preHandler: fastify.requireWorkspace('workspace:admin') },
    async (request) => {
      const body = UpdateEnvironmentSchema.parse(request.body);
      const workspace = request.workspace!;
      const updated = await withTenant(workspace.id, async (tx) => {
        const { hostApp, env } = await findEnvironment(tx, workspace.id, request.params);
        if (body.isDefault) {
          await tx.environment.updateMany({
            where: { hostAppId: hostApp.id, NOT: { id: env.id } },
            data: { isDefault: false },
          });
        }
        const updated = await tx.environment.update({ where: { id: env.id }, data: body });
        await audit(tx, workspace.id, actor(request), {
          action: 'environment.update',
          resourceType: 'environment',
          resourceId: env.id,
          metadata: { hostApp: hostApp.slug, slug: env.slug, ...body },
        });
        return updated;
      });
      return { slug: updated.slug, name: updated.name, isDefault: updated.isDefault };
    }
  );

  fastify.delete<{ Params: EnvParams }>(
    '/api/workspaces/:workspaceSlug/host-apps/:hostAppSlug/environments/:envSlug',
    { preHandler: fastify.requireWorkspace('workspace:admin') },
    async (request, reply) => {
      const workspace = request.workspace!;
      await withTenant(workspace.id, async (tx) => {
        const { hostApp, env } = await findEnvironment(tx, workspace.id, request.params);
        if (await tx.moduleVersion.count({ where: { environmentId: env.id, ...LIVE } })) {
          throw new ConflictError(`"${env.slug}" still serves module versions`);
        }
        await tx.environment.delete({ where: { id: env.id } });
        await audit(tx, workspace.id, actor(request), {
          action: 'environment.delete',
          resourceType: 'environment',
          resourceId: env.id,
          metadata: { hostApp: hostApp.slug, slug: env.slug },
        });
      });
      await invalidateManifest(
        fastify.container.cache,
        workspace.slug,
        request.params.hostAppSlug,
        request.params.envSlug
      );
      return reply.code(204).send();
    }
  );

  /** ENV-FRZ-03: the open override window, if any. */
  function overrideOf(
    env: Pick<Environment, 'freezeOverrideUntil' | 'freezeOverrideReason' | 'freezeOverrideBy'>
  ) {
    return env.freezeOverrideUntil && env.freezeOverrideUntil > new Date()
      ? {
          until: env.freezeOverrideUntil.toISOString(),
          reason: env.freezeOverrideReason,
          by: env.freezeOverrideBy,
        }
      : null;
  }

  // ─── Freeze (ENV-FRZ-01/02/06) ────────────────────────────────────────────

  async function setFreeze(request: FastifyRequest<{ Params: EnvParams }>, freeze: boolean) {
    const workspace = request.workspace!;
    const { hostAppSlug, envSlug } = request.params;
    const body = freeze ? FreezeRequestSchema.parse(request.body) : null;

    const env = await withTenant(workspace.id, async (tx) => {
      const hostApp = await tx.hostApp.findUnique({
        where: { workspaceId_slug: { workspaceId: workspace.id, slug: hostAppSlug } },
      });
      const current =
        hostApp &&
        (await tx.environment.findUnique({
          where: { hostAppId_slug: { hostAppId: hostApp.id, slug: envSlug } },
        }));
      if (!current) throw new NotFoundError('Environment not found');

      const updated = await tx.environment.update({
        where: { id: current.id },
        data: freeze
          ? {
              frozenAt: new Date(),
              frozenBy: request.principal!.id,
              freezeReason: body!.reason,
              freezeFrom: body!.from ? new Date(body!.from) : null,
              freezeUntil: body!.until ? new Date(body!.until) : null,
            }
          : {
              frozenAt: null,
              frozenBy: null,
              freezeReason: null,
              freezeFrom: null,
              freezeUntil: null,
              freezeOverrideUntil: null,
              freezeOverrideReason: null,
              freezeOverrideBy: null,
            },
      });
      await audit(tx, workspace.id, actor(request), {
        action: freeze ? 'env.freeze' : 'env.unfreeze',
        resourceType: 'environment',
        resourceId: updated.id,
        metadata: { hostApp: hostAppSlug, environment: envSlug, ...(body && body) },
      });
      return updated;
    });

    await webhooks.dispatch(workspace.id, freeze ? 'env.frozen' : 'env.unfrozen', {
      workspace: workspace.slug,
      hostApp: hostAppSlug,
      environment: envSlug,
      ...(body && body),
    });
    return {
      slug: env.slug,
      frozen: isFrozen(env),
      freezeReason: env.freezeReason,
      freezeFrom: env.freezeFrom?.toISOString() ?? null,
      freezeUntil: env.freezeUntil?.toISOString() ?? null,
      override: overrideOf(env),
    };
  }

  // DEP-04: active modules' dependencies against the host's shared ones, with conflicts.
  fastify.get<{ Params: EnvParams }>(
    '/api/workspaces/:workspaceSlug/host-apps/:hostAppSlug/environments/:envSlug/dependencies',
    { preHandler: fastify.requireWorkspace('workspace:read') },
    async (request) => {
      const workspace = request.workspace!;
      return withTenant(workspace.id, async (tx) => {
        const hostApp = await tx.hostApp.findUnique({
          where: {
            workspaceId_slug: { workspaceId: workspace.id, slug: request.params.hostAppSlug },
          },
        });
        const env =
          hostApp &&
          (await tx.environment.findUnique({
            where: { hostAppId_slug: { hostAppId: hostApp.id, slug: request.params.envSlug } },
          }));
        if (!hostApp || !env) throw new NotFoundError('Environment not found');
        return {
          hostApp: hostApp.slug,
          environment: env.slug,
          ...(await environmentMatrix(tx, hostApp, env.id)),
        };
      });
    }
  );

  // Manual re-publish, e.g. after fixing bucket credentials.
  fastify.post<{ Params: EnvParams }>(
    '/api/workspaces/:workspaceSlug/host-apps/:hostAppSlug/environments/:envSlug/publish',
    { preHandler: fastify.requireWorkspace('workspace:admin') },
    async (request) => {
      const workspace = request.workspace!;
      const env = await withTenant(workspace.id, async (tx) => {
        const hostApp = await tx.hostApp.findUnique({
          where: {
            workspaceId_slug: { workspaceId: workspace.id, slug: request.params.hostAppSlug },
          },
        });
        return hostApp
          ? tx.environment.findUnique({
              where: { hostAppId_slug: { hostAppId: hostApp.id, slug: request.params.envSlug } },
            })
          : null;
      });
      if (!env) throw new NotFoundError('Environment not found');
      const result = await publisher.publish(env.id);
      if (!result) throw new ConflictError('No storage configured to publish to');
      return result;
    }
  );

  const freezeRoute =
    '/api/workspaces/:workspaceSlug/host-apps/:hostAppSlug/environments/:envSlug/freeze';
  fastify.put<{ Params: EnvParams }>(
    freezeRoute,
    { preHandler: fastify.requireWorkspace('workspace:admin') },
    (request) => setFreeze(request, true)
  );
  fastify.delete<{ Params: EnvParams }>(
    freezeRoute,
    { preHandler: fastify.requireWorkspace('workspace:admin') },
    (request) => setFreeze(request, false)
  );

  // ENV-FRZ-03: owners open (POST) or close (DELETE) a window in which changes pass the
  // freeze, e.g. for a hotfix deployed by CI. Opening it is audited as env.freeze_override.
  async function setOverride(request: FastifyRequest<{ Params: EnvParams }>, open: boolean) {
    const workspace = request.workspace!;
    const { hostAppSlug, envSlug } = request.params;
    const body = open ? FreezeOverrideRequestSchema.parse(request.body) : null;
    const env = await withTenant(workspace.id, async (tx) => {
      const hostApp = await tx.hostApp.findUnique({
        where: { workspaceId_slug: { workspaceId: workspace.id, slug: hostAppSlug } },
      });
      const current =
        hostApp &&
        (await tx.environment.findUnique({
          where: { hostAppId_slug: { hostAppId: hostApp.id, slug: envSlug } },
        }));
      if (!current) throw new NotFoundError('Environment not found');
      if (open && !isFrozen(current)) throw new ConflictError(`"${envSlug}" is not frozen`);
      const until = body ? new Date(Date.now() + body.minutes * 60_000) : null;
      const updated = await tx.environment.update({
        where: { id: current.id },
        data: {
          freezeOverrideUntil: until,
          freezeOverrideReason: body?.reason ?? null,
          freezeOverrideBy: body ? request.principal!.id : null,
        },
      });
      await audit(tx, workspace.id, actor(request), {
        action: open ? 'env.freeze_override' : 'env.freeze_override_end',
        resourceType: 'environment',
        resourceId: updated.id,
        metadata: {
          hostApp: hostAppSlug,
          environment: envSlug,
          ...(body && { reason: body.reason, until: until!.toISOString() }),
          freezeReason: current.freezeReason,
        },
      });
      return updated;
    });
    return { slug: env.slug, frozen: isFrozen(env), override: overrideOf(env) };
  }
  fastify.post<{ Params: EnvParams }>(
    `${freezeRoute}/override`,
    { preHandler: fastify.requireWorkspace('workspace:owner') },
    (request) => setOverride(request, true)
  );
  fastify.delete<{ Params: EnvParams }>(
    `${freezeRoute}/override`,
    { preHandler: fastify.requireWorkspace('workspace:owner') },
    (request) => setOverride(request, false)
  );
};

export default hostAppRoutes;
