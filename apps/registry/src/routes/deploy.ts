import { FastifyPluginAsync } from 'fastify';
import { DeployRequestSchema } from '@harmoniq/core/dist/schemas/DeployRequestSchema';
import { S3StorageAdapter } from '../adapters/storage/S3StorageAdapter';
import { GCSStorageAdapter } from '../adapters/storage/GCSStorageAdapter';

const deployRoutes: FastifyPluginAsync = async (fastify, options) => {

  fastify.post<{
    Params: { workspaceSlug: string, moduleId: string },
    Body: { contentType: string, extension: string }
  }>('/api/workspaces/:workspaceSlug/modules/:moduleId/upload-url', {
    preHandler: fastify.verifyApiKey(['module:write']),
  }, async (request, reply) => {
    const { workspaceSlug, moduleId } = request.params;
    const { contentType, extension } = request.body;

    const workspace = await fastify.container.db.workspace.findUnique({
      where: { slug: workspaceSlug },
    });

    if (!workspace) {
      return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'Workspace not found' } });
    }

    const config = await fastify.container.db.workspaceStorageConfig.findUnique({
      where: { workspaceId: workspace.id }
    });

    if (!config) {
      return reply.code(400).send({ error: { code: 'BAD_REQUEST', message: 'Storage not configured for workspace' } });
    }

    const key = `modules/${moduleId}/${Date.now()}.${extension || 'js'}`;
    let url = '';

    if (config.provider === 'S3') {
      const s3Config = config.config as any;
      const s3 = new S3StorageAdapter(s3Config.region, s3Config.bucket, s3Config.accessKeyId, s3Config.secretAccessKey);
      url = await s3.getUploadUrl(key, contentType || 'application/javascript');
    } else if (config.provider === 'GCS') {
      const gcsConfig = config.config as any;
      const gcs = new GCSStorageAdapter(gcsConfig.projectId, gcsConfig.clientEmail, gcsConfig.privateKey, gcsConfig.bucket);
      url = await gcs.getUploadUrl(key, contentType || 'application/javascript');
    } else {
      return reply.code(400).send({ error: { code: 'BAD_REQUEST', message: 'Unsupported storage provider' } });
    }

    reply.send({ uploadUrl: url, key });
  });

  fastify.post<{
    Params: { workspaceSlug: string, moduleId: string }
  }>('/api/workspaces/:workspaceSlug/modules/:moduleId/deploy', {
    config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
    preHandler: fastify.verifyApiKey(['module:write']),
  }, async (request, reply) => {
    const { workspaceSlug, moduleId } = request.params;
    
    // Parse the body
    const parseResult = DeployRequestSchema.safeParse(request.body);
    if (!parseResult.success) {
      reply.code(400).send({ error: { code: 'BAD_REQUEST', message: 'Invalid payload', details: parseResult.error } });
      return;
    }
    const data = parseResult.data;

    // Check workspace & module
    const workspace = await fastify.container.db.workspace.findUnique({
      where: { slug: workspaceSlug },
    });

    if (!workspace) {
      reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'Workspace not found' } });
      return;
    }

    const module = await fastify.container.db.remoteModule.findFirst({
      where: { id: moduleId, workspaceId: workspace.id },
      include: {
        hostApp: {
          include: { Environments: true }
        }
      }
    });

    if (!module) {
      reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'Module not found' } });
      return;
    }

    // Default to production env for MVP simplicity
    const env = module.hostApp.Environments.find((e: any) => e.slug === 'production');
    if (!env) {
      reply.code(400).send({ error: { code: 'BAD_REQUEST', message: 'No production environment found' } });
      return;
    }

    if (data.dryRun) {
      reply.send({ message: 'Dry run successful, payload is valid.' });
      return;
    }

    const newVersion = await fastify.container.db.$transaction(async (tx) => {
      // Invalidate existing active versions for this env
      await tx.moduleVersion.updateMany({
        where: {
          remoteModuleId: module.id,
          environmentId: env.id,
          status: 'active'
        },
        data: { status: 'inactive' }
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
          deployedBy: request.apiKey?.id || 'system',
          deployedByType: 'apiKey',
        }
      });
    });

    // Invalidate manifest cache
    const cacheKeyPattern = `manifest:${workspaceSlug}:${module.hostApp.slug}:${env.slug}`;
    await fastify.container.cache.invalidatePattern(cacheKeyPattern);

    // Dispatch webhooks
    if (fastify.container.boss) {
      const endpoints = await fastify.container.db.webhookEndpoint.findMany({
        where: {
          workspaceId: workspace.id,
          active: true,
          paused: false,
          events: { has: 'module.deployed' }
        }
      });

      for (const endpoint of endpoints) {
        await fastify.container.boss.send('webhook.deliver', {
          workspaceId: workspace.id,
          webhookEndpointId: endpoint.id,
          event: 'module.deployed',
          payload: {
            module: module.slug,
            version: newVersion.version,
            environment: env.slug,
            deployedAt: newVersion.createdAt,
            url: newVersion.url
          },
          attempt: 0,
          firstAttemptAt: new Date().toISOString()
        });
      }
    }

    reply.code(201).send(newVersion);
  });

};

export default deployRoutes;
