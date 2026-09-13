import { FastifyPluginAsync } from 'fastify';

const webhookRoutes: FastifyPluginAsync = async (fastify, _options) => {
  fastify.post<{
    Params: { workspaceSlug: string; deadLetterId: string };
  }>(
    '/api/workspaces/:workspaceSlug/webhooks/dead-letters/:deadLetterId/retry',
    {
      config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
      preHandler: fastify.verifyApiKey(['module:write']),
    },
    async (request, reply) => {
      const { workspaceSlug, deadLetterId } = request.params;
      const { db, boss } = fastify.container;

      if (!boss) {
        reply
          .code(503)
          .send({ error: { code: 'UNAVAILABLE', message: 'Job queue is not available' } });
        return;
      }

      const workspace = await db.workspace.findUnique({
        where: { slug: workspaceSlug },
      });

      if (!workspace) {
        reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'Workspace not found' } });
        return;
      }

      const deadLetter = await db.webhookDeadLetter.findFirst({
        where: {
          id: deadLetterId,
          workspaceId: workspace.id,
        },
      });

      if (!deadLetter) {
        reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'Dead letter not found' } });
        return;
      }

      // Re-enqueue the webhook payload
      await boss.send('webhook.deliver', {
        workspaceId: deadLetter.workspaceId,
        webhookEndpointId: deadLetter.webhookEndpointId,
        event: deadLetter.event,
        payload: deadLetter.payload,
        attempt: 0,
        firstAttemptAt: new Date().toISOString(),
      });

      // Mark dead letter as resolved
      await db.webhookDeadLetter.update({
        where: { id: deadLetter.id },
        data: {
          resolvedAt: new Date(),
          retriedAt: new Date(),
        },
      });

      reply.code(200).send({ message: 'Dead letter re-enqueued for delivery' });
    }
  );
};

export default webhookRoutes;
