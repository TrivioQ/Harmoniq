import { FastifyPluginAsync } from 'fastify';
import { Prisma } from '@prisma/client';

const workspaceRoutes: FastifyPluginAsync = async (fastify, _options) => {
  fastify.get<{ Params: { slug: string } }>(
    '/api/workspaces/:slug/storage',
    {
      preHandler: [fastify.verifyAdmin],
    },
    async (request, reply) => {
      const { slug } = request.params;

      const workspace = await fastify.container.db.workspace.findUnique({
        where: { slug },
      });

      if (!workspace) {
        reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'Workspace not found' } });
        return;
      }

      const config = await fastify.container.db.workspaceStorageConfig.findUnique({
        where: { workspaceId: workspace.id },
      });

      reply.send({ storageConfig: config });
    }
  );

  fastify.post<{
    Params: { slug: string };
    Body: {
      provider: string;
      bucket: string;
      region: string;
      credentialsEncrypted: Record<string, unknown>;
      cdnPrefix?: string;
      pathPrefix?: string;
    };
  }>(
    '/api/workspaces/:slug/storage',
    {
      preHandler: [fastify.verifyAdmin],
    },
    async (request, reply) => {
      const { slug } = request.params;
      const { provider, bucket, region, credentialsEncrypted, cdnPrefix, pathPrefix } =
        request.body;

      const workspace = await fastify.container.db.workspace.findUnique({
        where: { slug },
      });

      if (!workspace) {
        reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'Workspace not found' } });
        return;
      }

      const payload = {
        provider,
        bucket,
        region,
        credentialsEncrypted: credentialsEncrypted as Prisma.InputJsonValue,
        cdnPrefix,
        pathPrefix,
      };

      const updated = await fastify.container.db.workspaceStorageConfig.upsert({
        where: { workspaceId: workspace.id },
        update: payload,
        create: { workspaceId: workspace.id, ...payload },
      });

      reply.send({ message: 'Storage config updated', storageConfig: updated });
    }
  );
};

export default workspaceRoutes;
