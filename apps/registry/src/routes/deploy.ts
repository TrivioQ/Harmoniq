import { FastifyPluginAsync } from 'fastify';
import { DeployRequestSchema } from '@harmoniq/core/dist/schemas/DeployRequestSchema';
import { createWorkspaceStorage } from '../adapters/storage/createStorage';
import { canAccessModule } from '../plugins/authenticate';

const deployRoutes: FastifyPluginAsync = async (fastify, _options) => {
  fastify.post<{
    Params: { workspaceSlug: string; moduleId: string };
    Body: { contentType: string; extension: string };
  }>(
    '/api/workspaces/:workspaceSlug/modules/:moduleId/upload-url',
    {
      preHandler: fastify.requireWorkspace('module:deploy'),
    },
    async (request, reply) => {
      const { moduleId } = request.params;
      const { contentType, extension } = request.body ?? {};
      const workspace = request.workspace!;

      if (!canAccessModule(request.principal, moduleId)) {
        return reply
          .code(403)
          .send({ error: { code: 'FORBIDDEN', message: 'API key is not scoped to this module' } });
      }

      const [module, config] = await fastify.container.withTenant(
        workspace.id,
        async (tx) =>
          [
            await tx.remoteModule.findFirst({ where: { id: moduleId } }),
            await tx.workspaceStorageConfig.findUnique({ where: { workspaceId: workspace.id } }),
          ] as const
      );

      if (!module) {
        return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'Module not found' } });
      }

      if (!config) {
        return reply.code(400).send({
          error: { code: 'BAD_REQUEST', message: 'Storage not configured for workspace' },
        });
      }

      // `extension` becomes part of an object key: allow only a short alphanumeric suffix.
      const safeExtension = /^[a-z0-9]{1,8}$/i.test(extension ?? '') ? extension : 'js';
      const key = `modules/${module.id}/${Date.now()}.${safeExtension}`;
      const storage = createWorkspaceStorage(config, fastify.config.encryptionKey);
      const url = await storage.getUploadUrl(key, contentType || 'application/javascript');

      reply.send({ uploadUrl: url, key });
    }
  );

  fastify.post<{
    Params: { workspaceSlug: string; moduleId: string };
  }>(
    '/api/workspaces/:workspaceSlug/modules/:moduleId/deploy',
    {
      config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
      preHandler: fastify.requireWorkspace('module:deploy'),
    },
    async (request, reply) => {
      const { workspaceSlug, moduleId } = request.params;
      const workspace = request.workspace!;

      if (!canAccessModule(request.principal, moduleId)) {
        return reply
          .code(403)
          .send({ error: { code: 'FORBIDDEN', message: 'API key is not scoped to this module' } });
      }

      // Parse the body
      const parseResult = DeployRequestSchema.safeParse(request.body);
      if (!parseResult.success) {
        reply.code(400).send({
          error: { code: 'BAD_REQUEST', message: 'Invalid payload', details: parseResult.error },
        });
        return;
      }
      const data = parseResult.data;

      const module = await fastify.container.withTenant(workspace.id, (tx) =>
        tx.remoteModule.findFirst({
          where: { id: moduleId },
          include: {
            hostApp: {
              include: { Environments: true },
            },
          },
        })
      );

      if (!module) {
        reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'Module not found' } });
        return;
      }

      // Default to production env for MVP simplicity
      const env = module.hostApp.Environments.find((e) => e.slug === 'production');
      if (!env) {
        reply
          .code(400)
          .send({ error: { code: 'BAD_REQUEST', message: 'No production environment found' } });
        return;
      }

      if (data.dryRun) {
        reply.send({ message: 'Dry run successful, payload is valid.' });
        return;
      }

      const newVersion = await fastify.container.withTenant(workspace.id, async (tx) => {
        // Invalidate existing active versions for this env
        await tx.moduleVersion.updateMany({
          where: {
            remoteModuleId: module.id,
            environmentId: env.id,
            status: 'active',
          },
          data: { status: 'inactive' },
        });

        // Create new active version
        return tx.moduleVersion.create({
          data: {
            workspaceId: workspace.id,
            remoteModuleId: module.id,
            environmentId: env.id,
            version: data.version,
            url: data.url,
            integrity: data.integrity,
            status: 'active',
            deployedBy: request.principal!.id,
            deployedByType: request.principal!.type,
          },
        });
      });

      // Invalidate manifest cache
      const cacheKeyPattern = `manifest:${workspaceSlug}:${module.hostApp.slug}:${env.slug}`;
      await fastify.container.cache.invalidatePattern(cacheKeyPattern);

      // Dispatch webhooks
      if (fastify.container.boss) {
        const endpoints = await fastify.container.withTenant(workspace.id, (tx) =>
          tx.webhookEndpoint.findMany({
            where: { active: true, paused: false, events: { has: 'module.deployed' } },
          })
        );

        for (const endpoint of endpoints) {
          await fastify.container.boss.send('webhook.deliver', {
            workspaceId: workspace.id,
            webhookEndpointId: endpoint.id,
            event: 'module.deployed',
            payload: {
              module: module.slug,
              version: newVersion.version,
              environment: env.slug,
              deployedAt: newVersion.deployedAt.toISOString(),
              url: newVersion.url,
            },
            attempt: 0,
            firstAttemptAt: new Date().toISOString(),
          });
        }
      }

      reply.code(201).send(newVersion);
    }
  );
};

export default deployRoutes;
