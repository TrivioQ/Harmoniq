import { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { Prisma } from '@prisma/client';
import {
  BadRequestError,
  ConflictError,
  ForbiddenError,
  NotFoundError,
  ValidationError,
} from '@harmoniq/core/dist/errors/AppError';
import { DeployRequestSchema } from '@harmoniq/core/dist/schemas/DeployRequestSchema';
import {
  PromoteRequestSchema,
  RollbackRequestSchema,
} from '@harmoniq/core/dist/schemas/RollbackRequestSchema';
import {
  CanaryActionRequestSchema,
  KillSwitchRequestSchema,
  SetCanaryRequestSchema,
} from '@harmoniq/core/dist/schemas/CanaryRequestSchema';
import {
  CreateModuleSchema,
  SlugSchema,
  UpdateModuleSchema,
} from '@harmoniq/core/dist/schemas/ResourceSchemas';
import { audit } from '../services/audit';
import { advanceRollout, clearedRollout, startRollout } from '../services/rollout';
import { isValidBundle } from '@harmoniq/core/dist/validation/bundle';
import { createWorkspaceStorage } from '../adapters/storage/createStorage';
import { canAccessModule } from '../plugins/authenticate';
import { validateBundleSafely } from '../services/bundleValidator';
import { isFrozen } from '../services/manifestMutation';
import { buildManifest } from '../services/manifestBuilder';
import { diffManifests } from '@harmoniq/core/dist/manifest/diff';
import {
  deactivateActive,
  endCanary,
  findCanary,
  findEnvironment,
  resolveModule,
  versionDto,
} from '../services/modules';

type ModuleParams = { workspaceSlug: string; moduleRef: string };

const json = (value: unknown) => (value ?? undefined) as Prisma.InputJsonValue | undefined;
const activeWhere = (remoteModuleId: string, environmentId: string) => ({
  remoteModuleId,
  environmentId,
  status: 'active' as const,
  deletedAt: null,
});

const moduleRoutes: FastifyPluginAsync = async (fastify) => {
  const { withTenant, mutations } = fastify.container;
  const { config } = fastify;

  const actor = (request: FastifyRequest) => ({ principal: request.principal!, ip: request.ip });

  /** Resolves the module and enforces module-scoped API keys (RBAC-04). */
  async function loadModule(request: FastifyRequest<{ Params: ModuleParams }>) {
    const module = await withTenant(request.workspace!.id, (tx) =>
      resolveModule(tx, request.params.moduleRef)
    );
    if (!canAccessModule(request.principal, module.id)) {
      throw new ForbiddenError('API key is not scoped to this module');
    }
    return module;
  }

  /**
   * Preview environments (M2.6): created on first deploy when the workspace allows it,
   * and their expiry pushed back on every later deploy. Permanent environments with the
   * same name are used as-is (never given an expiry).
   */
  async function ensurePreviewEnvironment(
    request: FastifyRequest,
    module: Awaited<ReturnType<typeof loadModule>>,
    slug: string,
    ttlHours: number
  ) {
    const workspace = request.workspace!;
    const expiresAt = new Date(Date.now() + ttlHours * 3_600_000);
    const existing = module.hostApp.Environments.find((e) => e.slug === slug);
    if (existing) {
      if (!existing.ephemeral) return existing;
      return withTenant(workspace.id, (tx) =>
        tx.environment.update({ where: { id: existing.id }, data: { expiresAt } })
      );
    }
    if (!workspace.allowEphemeralEnvironments) {
      throw new ForbiddenError('This workspace does not allow preview environments');
    }
    SlugSchema.parse(slug);
    const created = await withTenant(workspace.id, async (tx) => {
      const env = await tx.environment.create({
        data: { hostAppId: module.hostApp.id, slug, name: slug, ephemeral: true, expiresAt },
      });
      await audit(tx, workspace.id, actor(request), {
        action: 'environment.create',
        resourceType: 'environment',
        resourceId: env.id,
        metadata: { hostApp: module.hostApp.slug, slug, ephemeral: true, ttlHours },
      });
      return env;
    });
    module.hostApp.Environments.push(created);
    return created;
  }

  const targetFor = (
    request: FastifyRequest,
    module: Awaited<ReturnType<typeof loadModule>>,
    env: { id: string; slug: string }
  ) => ({ workspace: request.workspace!, hostApp: module.hostApp, environment: env });

  // ─── Reads ────────────────────────────────────────────────────────────────

  fastify.get<{ Params: { workspaceSlug: string } }>(
    '/api/workspaces/:workspaceSlug/modules',
    { preHandler: fastify.requireWorkspace('workspace:read') },
    async (request) => {
      const modules = await withTenant(request.workspace!.id, (tx) =>
        tx.remoteModule.findMany({
          orderBy: [{ hostApp: { slug: 'asc' } }, { slug: 'asc' }],
          include: {
            hostApp: { include: { Environments: { orderBy: { slug: 'asc' } } } },
            ModuleVersions: { where: { status: { in: ['active', 'canary'] }, deletedAt: null } },
            ModuleEnvStates: { where: { disabled: true } },
          },
        })
      );
      return {
        modules: modules.map((m) => ({
          id: m.id,
          name: m.name,
          slug: m.slug,
          description: m.description,
          hostApp: { slug: m.hostApp.slug, name: m.hostApp.name },
          environments: m.hostApp.Environments.map((env) => {
            const current = (status: 'active' | 'canary') =>
              m.ModuleVersions.find((v) => v.environmentId === env.id && v.status === status);
            const active = current('active');
            const canary = current('canary');
            const killed = m.ModuleEnvStates.find((d) => d.environmentId === env.id);
            return {
              slug: env.slug,
              name: env.name,
              frozen: isFrozen(env),
              active: active ? versionDto(active, env.slug) : null,
              canary: canary ? versionDto(canary, env.slug) : null,
              disabled: killed
                ? {
                    reason: killed.reason,
                    by: killed.updatedBy,
                    at: killed.updatedAt.toISOString(),
                  }
                : null,
            };
          }),
        })),
      };
    }
  );

  fastify.get<{ Params: ModuleParams }>(
    '/api/workspaces/:workspaceSlug/modules/:moduleRef',
    { preHandler: fastify.requireWorkspace('workspace:read') },
    async (request) => {
      const m = await loadModule(request);
      const killed = await withTenant(request.workspace!.id, (tx) =>
        tx.moduleEnvState.findMany({ where: { remoteModuleId: m.id, disabled: true } })
      );
      return {
        id: m.id,
        name: m.name,
        slug: m.slug,
        description: m.description,
        hostApp: { slug: m.hostApp.slug, name: m.hostApp.name },
        environments: m.hostApp.Environments.map((e) => {
          const state = killed.find((k) => k.environmentId === e.id);
          return {
            id: e.id,
            slug: e.slug,
            name: e.name,
            frozen: isFrozen(e),
            freezeReason: isFrozen(e) ? e.freezeReason : null,
            disabled: state ? { reason: state.reason, at: state.updatedAt.toISOString() } : null,
          };
        }),
      };
    }
  );

  // VER-05: full deployment history, newest first, cursor-paginated.
  fastify.get<{
    Params: ModuleParams;
    Querystring: { environment?: string; cursor?: string; limit?: string };
  }>(
    '/api/workspaces/:workspaceSlug/modules/:moduleRef/versions',
    { preHandler: fastify.requireWorkspace('workspace:read') },
    async (request) => {
      const m = await loadModule(request);
      const env = request.query.environment ? findEnvironment(m, request.query.environment) : null;
      const limit = Math.min(Math.max(Number(request.query.limit) || 50, 1), 200);
      const versions = await withTenant(request.workspace!.id, (tx) =>
        tx.moduleVersion.findMany({
          where: { remoteModuleId: m.id, deletedAt: null, ...(env && { environmentId: env.id }) },
          orderBy: [{ deployedAt: 'desc' }, { id: 'desc' }],
          take: limit + 1,
          ...(request.query.cursor && { cursor: { id: request.query.cursor }, skip: 1 }),
        })
      );
      const envSlug = new Map(m.hostApp.Environments.map((e) => [e.id, e.slug]));
      const page = versions.slice(0, limit);
      return {
        versions: page.map((v) => versionDto(v, envSlug.get(v.environmentId))),
        nextCursor: versions.length > limit ? page[page.length - 1].id : null,
      };
    }
  );

  // ─── Create ───────────────────────────────────────────────────────────────

  fastify.post<{ Params: { workspaceSlug: string } }>(
    '/api/workspaces/:workspaceSlug/modules',
    { preHandler: fastify.requireWorkspace('workspace:admin') },
    async (request, reply) => {
      const body = CreateModuleSchema.parse(request.body);
      const workspace = request.workspace!;
      const created = await withTenant(workspace.id, async (tx) => {
        const hostApp = await tx.hostApp.findUnique({
          where: { workspaceId_slug: { workspaceId: workspace.id, slug: body.hostApp } },
        });
        if (!hostApp) throw new NotFoundError(`Host app "${body.hostApp}" not found`);
        const exists = await tx.remoteModule.findUnique({
          where: { hostAppId_slug: { hostAppId: hostApp.id, slug: body.slug } },
        });
        if (exists)
          throw new ConflictError(`Module "${body.slug}" already exists in "${hostApp.slug}"`);
        const module = await tx.remoteModule.create({
          data: {
            workspaceId: workspace.id,
            hostAppId: hostApp.id,
            name: body.name,
            slug: body.slug,
            description: body.description,
          },
        });
        await tx.auditEvent.create({
          data: {
            workspaceId: workspace.id,
            actorId: request.principal!.id,
            actorType: request.principal!.type,
            action: 'module.create',
            resourceType: 'module',
            resourceId: module.id,
            metadata: { slug: module.slug, hostApp: hostApp.slug },
            ip: request.ip,
          },
        });
        return module;
      });
      return reply.code(201).send(created);
    }
  );

  fastify.patch<{ Params: ModuleParams }>(
    '/api/workspaces/:workspaceSlug/modules/:moduleRef',
    { preHandler: fastify.requireWorkspace('workspace:admin') },
    async (request) => {
      const body = UpdateModuleSchema.parse(request.body);
      const module = await loadModule(request);
      const workspace = request.workspace!;

      const { updated, auditEventId } = await withTenant(workspace.id, async (tx) => {
        const updated = await tx.remoteModule.update({ where: { id: module.id }, data: body });
        const event = await audit(tx, workspace.id, actor(request), {
          action: 'module.update',
          resourceType: 'module',
          resourceId: module.id,
          metadata: body,
        });
        return { updated, auditEventId: event.id };
      });

      // The specifier is part of every manifest of this host app: re-snapshot and publish.
      if (body.specifier !== undefined) {
        for (const environment of module.hostApp.Environments) {
          await mutations.rebuild(
            { workspace, hostApp: module.hostApp, environment },
            auditEventId
          );
        }
      }
      return {
        id: updated.id,
        name: updated.name,
        slug: updated.slug,
        description: updated.description,
        specifier: updated.specifier,
      };
    }
  );

  // ─── Upload ───────────────────────────────────────────────────────────────

  fastify.post<{ Params: ModuleParams; Body: { contentType?: string; extension?: string } }>(
    '/api/workspaces/:workspaceSlug/modules/:moduleRef/upload-url',
    { preHandler: fastify.requireWorkspace('module:deploy') },
    async (request) => {
      const module = await loadModule(request);
      const workspace = request.workspace!;
      const storageConfig = await withTenant(workspace.id, (tx) =>
        tx.workspaceStorageConfig.findUnique({ where: { workspaceId: workspace.id } })
      );
      if (!storageConfig) throw new BadRequestError('Storage not configured for workspace');

      // `extension` becomes part of an object key: allow only a short alphanumeric suffix.
      const { contentType, extension } = request.body ?? {};
      const safeExtension = /^[a-z0-9]{1,8}$/i.test(extension ?? '') ? extension : 'js';
      const key = `modules/${module.id}/${Date.now()}.${safeExtension}`;
      const storage = createWorkspaceStorage(storageConfig, config.encryptionKey);
      return {
        uploadUrl: await storage.getUploadUrl(key, contentType || 'application/javascript'),
        key,
      };
    }
  );

  // ─── Deploy ───────────────────────────────────────────────────────────────

  fastify.post<{ Params: ModuleParams }>(
    '/api/workspaces/:workspaceSlug/modules/:moduleRef/deploy',
    {
      config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
      preHandler: fastify.requireWorkspace('module:deploy'),
    },
    async (request, reply) => {
      const body = DeployRequestSchema.parse(request.body);
      const module = await loadModule(request);
      const workspace = request.workspace!;
      const env =
        body.ephemeral && !body.dryRun
          ? await ensurePreviewEnvironment(
              request,
              module,
              body.environment,
              body.ephemeral.ttlHours
            )
          : findEnvironment(module, body.environment);

      // VAL-02/03: dry runs always validate; real deploys when HARMONIQ_VALIDATE_BUNDLES=1.
      const validation =
        body.dryRun || config.validateBundles
          ? await validateBundleSafely(body.url, body.integrity, {
              allowHttp: !config.isProduction,
            })
          : null;

      if (body.dryRun) {
        const projected = await withTenant(workspace.id, async (tx) => {
          const current = await buildManifest(tx, {
            workspaceSlug: workspace.slug,
            hostApp: module.hostApp,
            environment: env,
          });
          const next = {
            modules: [
              ...current.manifest.modules.filter((m) => m.name !== module.slug),
              {
                name: module.slug,
                url: body.url,
                integrity: body.integrity,
                version: body.version,
              },
            ],
          };
          return diffManifests(current.manifest, next);
        });
        return {
          dryRun: true,
          validation: { ...validation!, dependencyConflicts: [] },
          frozen: isFrozen(env),
          projectedDiff: projected,
        };
      }

      if (validation && !isValidBundle(validation)) {
        throw new ValidationError('Bundle failed validation', { validation });
      }

      const { result, manifest, snapshotId } = await mutations.run(
        targetFor(request, module, env),
        actor(request),
        async (tx) => {
          const canary = body.canary;
          if (
            canary &&
            !(await tx.moduleVersion.count({ where: activeWhere(module.id, env.id) }))
          ) {
            throw new ConflictError(
              `No active version of "${module.slug}" in "${env.slug}" to run a canary against; deploy it normally first`
            );
          }
          // A canary deploy replaces the running canary; a normal deploy ends it.
          const endedCanary = await endCanary(tx, module.id, env.id);
          if (!canary) await deactivateActive(tx, module.id, env.id);
          const version = await tx.moduleVersion.create({
            data: {
              workspaceId: workspace.id,
              remoteModuleId: module.id,
              environmentId: env.id,
              version: body.version,
              url: body.url,
              integrity: body.integrity,
              status: canary ? 'canary' : 'active',
              ...(canary?.rollout
                ? startRollout(canary.rollout)
                : { trafficPercent: canary?.trafficPercent }),
              ...(canary?.targeting?.length && { targeting: json(canary.targeting) }),
              activatedAt: canary ? null : new Date(),
              deployedBy: request.principal!.id,
              deployedByType: request.principal!.type,
              commitSha: body.commitSha,
              metadata: json(body.metadata),
              dependencies: json(body.dependencies),
              exposes: json(body.exposes),
              storagePath: body.storagePath,
            },
          });
          return {
            result: version,
            audit: {
              action: 'module.deploy',
              resourceType: 'moduleVersion',
              resourceId: version.id,
              metadata: {
                module: module.slug,
                environment: env.slug,
                version: version.version,
                url: version.url,
                ...(canary && {
                  canary: true,
                  trafficPercent: version.trafficPercent,
                  ...(canary.rollout && { rollout: canary.rollout }),
                }),
                ...(endedCanary && {
                  endedCanary: { versionId: endedCanary.id, version: endedCanary.version },
                }),
                ...(validation && { validation }), // VAL-05
              },
            },
            events: [
              {
                name: 'deploy.success',
                payload: {
                  module: module.slug,
                  version: version.version,
                  versionId: version.id,
                  url: version.url,
                  ...(canary && { canary: true, trafficPercent: version.trafficPercent }),
                },
              },
              ...(canary
                ? [
                    {
                      name: 'canary.started' as const,
                      payload: {
                        module: module.slug,
                        version: version.version,
                        versionId: version.id,
                        trafficPercent: version.trafficPercent,
                        ...(canary.rollout && { rollout: canary.rollout }),
                      },
                    },
                  ]
                : []),
            ],
          };
        }
      );

      fastify.metricMeters.deployCount.add(1);
      const previewUrl = module.hostApp.previewUrlTemplate?.replace(
        '{environment}',
        encodeURIComponent(env.slug)
      );
      return reply.code(201).send({
        ...versionDto(result, env.slug),
        manifestEtag: manifest.etag,
        snapshotId,
        ...(previewUrl && { previewUrl }),
      });
    }
  );

  // ─── Rollback (VER-04) ────────────────────────────────────────────────────

  fastify.post<{ Params: ModuleParams }>(
    '/api/workspaces/:workspaceSlug/modules/:moduleRef/rollback',
    { preHandler: fastify.requireWorkspace('module:deploy') },
    async (request) => {
      const body = RollbackRequestSchema.parse(request.body);
      const module = await loadModule(request);
      const env = findEnvironment(module, body.environment);

      const { result, manifest, snapshotId } = await mutations.run(
        targetFor(request, module, env),
        actor(request),
        async (tx) => {
          const scope = { remoteModuleId: module.id, environmentId: env.id, deletedAt: null };
          const current = await tx.moduleVersion.findFirst({
            where: { ...scope, status: 'active' },
          });

          const target = body.versionId
            ? await tx.moduleVersion.findFirst({ where: { ...scope, id: body.versionId } })
            : body.version
              ? await tx.moduleVersion.findFirst({
                  where: { ...scope, version: body.version, status: { not: 'canary' } },
                  orderBy: { deployedAt: 'desc' },
                })
              : // "previous": the most recent other version deployed before the current one.
                // Only versions that were active once: never an aborted canary.
                await tx.moduleVersion.findFirst({
                  where: {
                    ...scope,
                    status: 'inactive',
                    activatedAt: { not: null },
                    ...(current && { deployedAt: { lt: current.deployedAt } }),
                  },
                  orderBy: { deployedAt: 'desc' },
                });

          if (!target) throw new NotFoundError('No version to roll back to in this environment');
          if (target.status === 'active')
            throw new ConflictError(`${target.version} is already active`);
          if (target.status === 'canary') {
            throw new ConflictError('Cannot roll back to a canary version; promote it instead');
          }

          await deactivateActive(tx, module.id, env.id);
          const activated = await tx.moduleVersion.update({
            where: { id: target.id },
            data: { status: 'active', activatedAt: new Date() },
          });
          return {
            result: activated,
            audit: {
              action: 'module.rollback',
              resourceType: 'moduleVersion',
              resourceId: activated.id,
              metadata: {
                module: module.slug,
                environment: env.slug,
                fromVersion: current?.version ?? null,
                fromVersionId: current?.id ?? null,
                toVersion: activated.version,
              },
            },
            events: [
              {
                name: 'rollback.executed',
                payload: {
                  module: module.slug,
                  fromVersion: current?.version ?? null,
                  toVersion: activated.version,
                  versionId: activated.id,
                },
              },
            ],
          };
        }
      );
      return { ...versionDto(result, env.slug), manifestEtag: manifest.etag, snapshotId };
    }
  );

  // ─── Promote (PRO-01..06) ─────────────────────────────────────────────────

  fastify.post<{ Params: ModuleParams }>(
    '/api/workspaces/:workspaceSlug/modules/:moduleRef/promote',
    { preHandler: fastify.requireWorkspace('module:deploy') },
    async (request, reply) => {
      const body = PromoteRequestSchema.parse(request.body);
      if (body.fromEnvironment === body.toEnvironment) {
        throw new BadRequestError('fromEnvironment and toEnvironment must differ');
      }
      const module = await loadModule(request);
      const from = findEnvironment(module, body.fromEnvironment);
      const to = findEnvironment(module, body.toEnvironment);
      const workspace = request.workspace!;

      // The freeze check in the pipeline applies to the target environment (PRO-03).
      const { result, manifest, snapshotId } = await mutations.run(
        targetFor(request, module, to),
        actor(request),
        async (tx) => {
          const source = await tx.moduleVersion.findFirst({
            where: {
              remoteModuleId: module.id,
              environmentId: from.id,
              deletedAt: null,
              ...(body.versionId ? { id: body.versionId } : { status: 'active' }),
            },
          });
          if (!source) throw new NotFoundError(`No version to promote in "${from.slug}"`);

          await deactivateActive(tx, module.id, to.id);
          // The exact artifact that was tested: same URL, integrity and metadata.
          const promoted = await tx.moduleVersion.create({
            data: {
              workspaceId: workspace.id,
              remoteModuleId: module.id,
              environmentId: to.id,
              version: source.version,
              url: source.url,
              integrity: source.integrity,
              storagePath: source.storagePath,
              commitSha: source.commitSha,
              metadata: json(source.metadata),
              dependencies: json(source.dependencies),
              exposes: json(source.exposes),
              status: 'active',
              activatedAt: new Date(),
              deployedBy: request.principal!.id,
              deployedByType: request.principal!.type,
              promotedFromId: source.id,
              promotedFromEnv: from.slug,
            },
          });
          return {
            result: promoted,
            audit: {
              action: 'module.promote',
              resourceType: 'moduleVersion',
              resourceId: promoted.id,
              metadata: {
                module: module.slug,
                version: promoted.version,
                fromEnvironmentId: from.id,
                toEnvironmentId: to.id,
                fromEnvironment: from.slug,
                toEnvironment: to.slug,
                sourceVersionId: source.id,
              },
            },
            events: [
              {
                name: 'module.promoted',
                payload: {
                  module: module.slug,
                  version: promoted.version,
                  fromEnvironment: from.slug,
                  toEnvironment: to.slug,
                  versionId: promoted.id,
                },
              },
            ],
          };
        }
      );
      return reply
        .code(201)
        .send({ ...versionDto(result, to.slug), manifestEtag: manifest.etag, snapshotId });
    }
  );

  // ─── Kill switch (M3.6) ───────────────────────────────────────────────────

  // Hosts stop loading the module at their next manifest fetch. An emergency control:
  // it works in frozen environments.
  fastify.put<{ Params: ModuleParams }>(
    '/api/workspaces/:workspaceSlug/modules/:moduleRef/kill-switch',
    { preHandler: fastify.requireWorkspace('module:deploy') },
    async (request) => {
      const body = KillSwitchRequestSchema.parse(request.body);
      const module = await loadModule(request);
      const env = findEnvironment(module, body.environment);
      const workspace = request.workspace!;

      const { result, manifest, snapshotId } = await mutations.run(
        targetFor(request, module, env),
        actor(request),
        async (tx) => {
          const state = await tx.moduleEnvState.upsert({
            where: {
              remoteModuleId_environmentId: { remoteModuleId: module.id, environmentId: env.id },
            },
            create: {
              workspaceId: workspace.id,
              remoteModuleId: module.id,
              environmentId: env.id,
              disabled: body.disabled,
              reason: body.disabled ? body.reason : null,
              updatedBy: request.principal!.id,
            },
            update: {
              disabled: body.disabled,
              reason: body.disabled ? body.reason : null,
              updatedBy: request.principal!.id,
            },
          });
          const change = {
            module: module.slug,
            disabled: state.disabled,
            ...(state.reason && { reason: state.reason }),
          };
          return {
            result: state,
            audit: {
              action: body.disabled ? 'module.disable' : 'module.enable',
              resourceType: 'remoteModule',
              resourceId: module.id,
              metadata: { ...change, environment: env.slug },
            },
            events: [
              { name: body.disabled ? 'module.disabled' : 'module.enabled', payload: change },
            ],
          };
        },
        { ignoreFreeze: true }
      );
      return {
        module: module.slug,
        environment: env.slug,
        disabled: result.disabled,
        reason: result.reason,
        manifestEtag: manifest.etag,
        snapshotId,
      };
    }
  );

  // ─── Canary (CAN-01..05) ──────────────────────────────────────────────────

  // Sets the traffic of the running canary, or makes an earlier version the canary.
  fastify.put<{ Params: ModuleParams }>(
    '/api/workspaces/:workspaceSlug/modules/:moduleRef/canary',
    { preHandler: fastify.requireWorkspace('module:deploy') },
    async (request) => {
      const body = SetCanaryRequestSchema.parse(request.body);
      const module = await loadModule(request);
      const env = findEnvironment(module, body.environment);

      const { result, manifest, snapshotId } = await mutations.run(
        targetFor(request, module, env),
        actor(request),
        async (tx) => {
          const current = await findCanary(tx, module.id, env.id);

          if (!body.versionId || body.versionId === current?.id) {
            if (!current) {
              throw new NotFoundError(
                `No canary of "${module.slug}" in "${env.slug}"; deploy one with a canary or pass versionId`
              );
            }
            const percent = body.trafficPercent ?? current.trafficPercent ?? 0;
            const rules = body.targeting ?? (current.targeting as unknown[] | null) ?? [];
            if (percent === 0 && !rules.length) {
              throw new BadRequestError('A canary at 0% needs targeting rules');
            }
            const updated = await tx.moduleVersion.update({
              where: { id: current.id },
              data: {
                // Setting traffic by hand takes over from a staged rollout.
                ...(body.trafficPercent !== undefined && {
                  trafficPercent: body.trafficPercent,
                  ...clearedRollout,
                }),
                ...(body.targeting && {
                  targeting: body.targeting.length ? json(body.targeting) : Prisma.DbNull,
                }),
              },
            });
            const change = {
              module: module.slug,
              version: updated.version,
              versionId: updated.id,
              fromTrafficPercent: current.trafficPercent,
              trafficPercent: updated.trafficPercent,
              ...(body.targeting && { targeting: body.targeting }),
            };
            return {
              result: updated,
              audit: {
                action: 'canary.update',
                resourceType: 'moduleVersion',
                resourceId: updated.id,
                metadata: { ...change, environment: env.slug },
              },
              events: [{ name: 'canary.updated', payload: change }],
            };
          }

          const target = await tx.moduleVersion.findFirst({
            where: {
              id: body.versionId,
              remoteModuleId: module.id,
              environmentId: env.id,
              deletedAt: null,
            },
          });
          if (!target) throw new NotFoundError('Version not found in this environment');
          if (target.status === 'active') {
            throw new ConflictError(`${target.version} is the active version`);
          }
          if (!(await tx.moduleVersion.count({ where: activeWhere(module.id, env.id) }))) {
            throw new ConflictError('No active version to run a canary against');
          }
          if (body.trafficPercent === 0 && !body.targeting?.length) {
            throw new BadRequestError('A canary at 0% needs targeting rules');
          }
          const ended = await endCanary(tx, module.id, env.id);
          const started = await tx.moduleVersion.update({
            where: { id: target.id },
            data: {
              status: 'canary',
              trafficPercent: body.trafficPercent,
              targeting: body.targeting?.length ? json(body.targeting) : Prisma.DbNull,
              ...clearedRollout,
            },
          });
          const change = {
            module: module.slug,
            version: started.version,
            versionId: started.id,
            trafficPercent: started.trafficPercent,
            ...(body.targeting?.length && { targeting: body.targeting }),
          };
          return {
            result: started,
            audit: {
              action: 'canary.start',
              resourceType: 'moduleVersion',
              resourceId: started.id,
              metadata: {
                ...change,
                environment: env.slug,
                ...(ended && { endedCanary: { versionId: ended.id, version: ended.version } }),
              },
            },
            events: [{ name: 'canary.started', payload: change }],
          };
        }
      );
      return { ...versionDto(result, env.slug), manifestEtag: manifest.etag, snapshotId };
    }
  );

  // CAN-04: the canary becomes the active version for everyone.
  fastify.post<{ Params: ModuleParams }>(
    '/api/workspaces/:workspaceSlug/modules/:moduleRef/canary/promote',
    { preHandler: fastify.requireWorkspace('module:deploy') },
    async (request) => {
      const body = CanaryActionRequestSchema.parse(request.body);
      const module = await loadModule(request);
      const env = findEnvironment(module, body.environment);

      const { result, manifest, snapshotId } = await mutations.run(
        targetFor(request, module, env),
        actor(request),
        async (tx) => {
          const canary = await findCanary(tx, module.id, env.id);
          if (!canary) throw new NotFoundError(`No canary of "${module.slug}" in "${env.slug}"`);
          const previous = await tx.moduleVersion.findFirst({
            where: activeWhere(module.id, env.id),
          });
          await deactivateActive(tx, module.id, env.id);
          const promoted = await tx.moduleVersion.update({
            where: { id: canary.id },
            data: {
              status: 'active',
              trafficPercent: null,
              targeting: Prisma.DbNull,
              activatedAt: new Date(),
              ...clearedRollout,
            },
          });
          const change = {
            module: module.slug,
            version: promoted.version,
            versionId: promoted.id,
            fromVersion: previous?.version ?? null,
            trafficPercent: canary.trafficPercent,
          };
          return {
            result: promoted,
            audit: {
              action: 'canary.promote',
              resourceType: 'moduleVersion',
              resourceId: promoted.id,
              metadata: {
                ...change,
                environment: env.slug,
                ...(body.reason && { reason: body.reason }),
              },
            },
            events: [{ name: 'canary.promoted', payload: change }],
          };
        }
      );
      return { ...versionDto(result, env.slug), manifestEtag: manifest.etag, snapshotId };
    }
  );

  // STG-05: move a staged rollout to its next band now, skipping the gate.
  fastify.post<{ Params: ModuleParams }>(
    '/api/workspaces/:workspaceSlug/modules/:moduleRef/canary/advance',
    { preHandler: fastify.requireWorkspace('module:deploy') },
    async (request) => {
      const body = CanaryActionRequestSchema.parse(request.body);
      const module = await loadModule(request);
      const env = findEnvironment(module, body.environment);
      const { result, manifest, snapshotId } = await advanceRollout(
        { mutations },
        { workspace: request.workspace!, hostApp: module.hostApp, environment: env, module },
        actor(request),
        { manual: true }
      );
      return { ...versionDto(result, env.slug), manifestEtag: manifest.etag, snapshotId };
    }
  );

  // CAN-04: everyone goes back to the active version.
  fastify.post<{ Params: ModuleParams }>(
    '/api/workspaces/:workspaceSlug/modules/:moduleRef/canary/abort',
    { preHandler: fastify.requireWorkspace('module:deploy') },
    async (request) => {
      const body = CanaryActionRequestSchema.parse(request.body);
      const module = await loadModule(request);
      const env = findEnvironment(module, body.environment);

      const { result, manifest, snapshotId } = await mutations.run(
        targetFor(request, module, env),
        actor(request),
        async (tx) => {
          const canary = await endCanary(tx, module.id, env.id);
          if (!canary) throw new NotFoundError(`No canary of "${module.slug}" in "${env.slug}"`);
          const change = {
            module: module.slug,
            version: canary.version,
            versionId: canary.id,
            trafficPercent: canary.trafficPercent,
            ...(body.reason && { reason: body.reason }),
          };
          return {
            result: { ...canary, status: 'inactive' as const, trafficPercent: null },
            audit: {
              action: 'canary.abort',
              resourceType: 'moduleVersion',
              resourceId: canary.id,
              metadata: { ...change, environment: env.slug },
            },
            events: [{ name: 'canary.rolled_back', payload: change }],
          };
        }
      );
      return { ...versionDto(result, env.slug), manifestEtag: manifest.etag, snapshotId };
    }
  );
};

export default moduleRoutes;
