import { FastifyPluginAsync } from 'fastify';

const workspaceRoutes: FastifyPluginAsync = async (fastify, options) => {
  fastify.get<{ Params: { slug: string } }>('/api/workspaces/:slug/storage', {
    preHandler: [fastify.verifyAdmin]
  }, async (request, reply) => {
    const { slug } = request.params;
    
    const workspace = await fastify.container.db.workspace.findUnique({
      where: { slug }
    });

    if (!workspace) {
      reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'Workspace not found' } });
      return;
    }

    const config = await fastify.container.db.workspaceStorageConfig.findUnique({
      where: { workspaceId: workspace.id }
    });

    reply.send({ storageConfig: config });
  });

  fastify.post<{
    Params: { slug: string },
    Body: { provider: 'S3' | 'GCS' | 'LOCAL', config: any }
  }>('/api/workspaces/:slug/storage', {
    preHandler: [fastify.verifyAdmin]
  }, async (request, reply) => {
    const { slug } = request.params;
    const { provider, config } = request.body;
    
    const workspace = await fastify.container.db.workspace.findUnique({
      where: { slug }
    });

    if (!workspace) {
      reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'Workspace not found' } });
      return;
    }

    const updated = await fastify.container.db.workspaceStorageConfig.upsert({
      where: { workspaceId: workspace.id },
      update: { provider, config },
      create: { workspaceId: workspace.id, provider, config }
    });

    reply.send({ message: 'Storage config updated', storageConfig: updated });
  });
};

export default workspaceRoutes;
