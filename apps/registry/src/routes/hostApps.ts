import { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { Prisma } from '@prisma/client';
import { ConflictError, ForbiddenError, NotFoundError } from '@harmoniq/core/dist/errors/AppError';
import {
  CreateEnvironmentSchema,
  CreateHostAppSchema,
  CreateWorkspaceSchema,
} from '@harmoniq/core/dist/schemas/ResourceSchemas';
import { FreezeRequestSchema } from '@harmoniq/core/dist/schemas/RollbackRequestSchema';
import { audit } from '../services/audit';
import { isFrozen } from '../services/manifestMutation';

type WsParams = { workspaceSlug: string };
type EnvParams = WsParams & { hostAppSlug: string; envSlug: string };

const titleCase = (slug: string) => slug.charAt(0).toUpperCase() + slug.slice(1).replace(/-/g, ' ');

const hostAppRoutes: FastifyPluginAsync = async (fastify) => {
  const { systemDb, withTenant, webhooks } = fastify.container;
  const actor = (request: FastifyRequest) => ({ principal: request.principal!, ip: request.ip });

  // ─── Workspaces ───────────────────────────────────────────────────────────

  // Any signed-in user can create a workspace and becomes its owner. API keys cannot.
  fastify.post('/api/workspaces', { preHandler: fastify.authenticate }, async (request, reply) => {
    const principal = request.principal!;
    if (principal.type !== 'user') throw new ForbiddenError('Workspaces are created by users');
    const body = CreateWorkspaceSchema.parse(request.body);

    try {
      // System role: the workspace (and therefore its tenant context) doesn't exist yet.
      const workspace = await systemDb.$transaction(async (tx) => {
        const ws = await tx.workspace.create({ data: { name: body.name, slug: body.slug } });
        await tx.workspaceMember.create({
          data: { workspaceId: ws.id, userId: principal.id, role: 'owner', joinedAt: new Date() },
        });
        await tx.hostApp.create({
          data: {
            workspaceId: ws.id,
            name: 'Default',
            slug: 'default',
            isDefault: true,
            Environments: {
              create: [
                { name: 'Staging', slug: 'staging' },
                { name: 'Production', slug: 'production', isDefault: true },
              ],
            },
          },
        });
        await tx.auditEvent.create({
          data: {
            workspaceId: ws.id,
            actorId: principal.id,
            actorType: 'user',
            action: 'workspace.create',
            resourceType: 'workspace',
            resourceId: ws.id,
            ip: request.ip,
          },
        });
        return ws;
      });
      return reply.code(201).send({ slug: workspace.slug, name: workspace.name });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        throw new ConflictError(`Workspace slug "${body.slug}" is taken`);
      }
      throw err;
    }
  });

  fastify.get<{ Params: WsParams }>(
    '/api/workspaces/:workspaceSlug',
    { preHandler: fastify.requireWorkspace('workspace:read') },
    async (request) => {
      const workspace = request.workspace!;
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
        role: request.workspaceRole ?? null,
        hostApps: hostApps.map((h) => ({
          slug: h.slug,
          name: h.name,
          description: h.description,
          isDefault: h.isDefault,
          moduleCount: h._count.RemoteModules,
          environments: h.Environments.map((e) => ({
            slug: e.slug,
            name: e.name,
            isDefault: e.isDefault,
            frozen: isFrozen(e),
            freezeReason: isFrozen(e) ? e.freezeReason : null,
            freezeUntil: isFrozen(e) ? (e.freezeUntil?.toISOString() ?? null) : null,
            frozenBy: isFrozen(e) ? e.frozenBy : null,
          })),
        })),
      };
    }
  );

  // ─── Host apps & environments ─────────────────────────────────────────────

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
      return reply.code(201).send({ slug: env.slug, name: env.name });
    }
  );

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
              freezeUntil: body!.until ? new Date(body!.until) : null,
            }
          : { frozenAt: null, frozenBy: null, freezeReason: null, freezeUntil: null },
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
      freezeUntil: env.freezeUntil?.toISOString() ?? null,
    };
  }

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
};

export default hostAppRoutes;
