import { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { randomBytes } from 'crypto';
import { z } from 'zod';
import type { WebhookEndpoint } from '@prisma/client';
import { BadRequestError, NotFoundError } from '@harmoniq/core/dist/errors/AppError';
import { WebhookEventNameSchema } from '@harmoniq/core/dist/schemas/WebhookEventSchema';
import { audit } from '../services/audit';
import { checkPublicUrl } from '../services/bundleValidator';
import { sealSecret } from '../services/crypto';

type WsParams = { workspaceSlug: string };
type EndpointParams = WsParams & { endpointId: string };

const EventsSchema = z.array(z.union([WebhookEventNameSchema, z.literal('*')])).min(1);
const CreateEndpointSchema = z.object({
  url: z.string().url(),
  events: EventsSchema,
  maxRetries: z.number().int().min(0).max(25).default(5), // WHK-03
  backoffCeilingMs: z.number().int().min(1000).max(3_600_000).default(300_000), // WHK-06
});
const UpdateEndpointSchema = CreateEndpointSchema.partial().extend({
  active: z.boolean().optional(),
  paused: z.boolean().optional(), // WHK-10
});

// Secrets are never returned after creation.
const endpointDto = (e: WebhookEndpoint) => ({
  id: e.id,
  url: e.url,
  events: e.events,
  active: e.active,
  paused: e.paused,
  maxRetries: e.maxRetries,
  backoffCeilingMs: e.backoffCeilingMs,
  createdAt: e.createdAt.toISOString(),
});

const webhookRoutes: FastifyPluginAsync = async (fastify, _options) => {
  const admin = { preHandler: fastify.requireWorkspace('workspace:admin') };
  const actor = (request: FastifyRequest) => ({ principal: request.principal!, ip: request.ip });

  // The registry will POST to this URL, so it gets the same SSRF guard as bundle URLs.
  async function assertDeliverable(url: string) {
    const blocked = await checkPublicUrl(url, { allowHttp: !fastify.config.isProduction });
    if (blocked) throw new BadRequestError(`Webhook URL rejected: ${blocked}`);
  }

  fastify.get<{ Params: WsParams }>(
    '/api/workspaces/:workspaceSlug/webhooks',
    admin,
    async (request) => {
      const endpoints = await fastify.container.withTenant(request.workspace!.id, (tx) =>
        tx.webhookEndpoint.findMany({ orderBy: { createdAt: 'asc' } })
      );
      return { endpoints: endpoints.map(endpointDto) };
    }
  );

  fastify.post<{ Params: WsParams }>(
    '/api/workspaces/:workspaceSlug/webhooks',
    admin,
    async (request, reply) => {
      const body = CreateEndpointSchema.parse(request.body);
      await assertDeliverable(body.url);
      const workspace = request.workspace!;
      // WHK-05: per-endpoint HMAC secret, shown once, encrypted at rest.
      const secret = `whsec_${randomBytes(32).toString('base64url')}`;
      const endpoint = await fastify.container.withTenant(workspace.id, async (tx) => {
        const created = await tx.webhookEndpoint.create({
          data: {
            ...body,
            workspaceId: workspace.id,
            secret: sealSecret(secret, fastify.config.encryptionKey),
          },
        });
        await audit(tx, workspace.id, actor(request), {
          action: 'webhook.create',
          resourceType: 'webhookEndpoint',
          resourceId: created.id,
          metadata: { url: created.url, events: created.events },
        });
        return created;
      });
      return reply.code(201).send({ ...endpointDto(endpoint), secret });
    }
  );

  fastify.patch<{ Params: EndpointParams }>(
    '/api/workspaces/:workspaceSlug/webhooks/:endpointId',
    admin,
    async (request) => {
      const body = UpdateEndpointSchema.parse(request.body);
      if (body.url) await assertDeliverable(body.url);
      const workspace = request.workspace!;
      const endpoint = await fastify.container.withTenant(workspace.id, async (tx) => {
        const existing = await tx.webhookEndpoint.findUnique({
          where: { id: request.params.endpointId },
        });
        if (!existing) throw new NotFoundError('Webhook endpoint not found');
        const updated = await tx.webhookEndpoint.update({ where: { id: existing.id }, data: body });
        await audit(tx, workspace.id, actor(request), {
          action: 'webhook.update',
          resourceType: 'webhookEndpoint',
          resourceId: updated.id,
          metadata: body,
        });
        return updated;
      });
      return endpointDto(endpoint);
    }
  );

  fastify.delete<{ Params: EndpointParams }>(
    '/api/workspaces/:workspaceSlug/webhooks/:endpointId',
    admin,
    async (request, reply) => {
      const workspace = request.workspace!;
      await fastify.container.withTenant(workspace.id, async (tx) => {
        const existing = await tx.webhookEndpoint.findUnique({
          where: { id: request.params.endpointId },
        });
        if (!existing) throw new NotFoundError('Webhook endpoint not found');
        await tx.webhookEndpoint.delete({ where: { id: existing.id } });
        await audit(tx, workspace.id, actor(request), {
          action: 'webhook.delete',
          resourceType: 'webhookEndpoint',
          resourceId: existing.id,
          metadata: { url: existing.url },
        });
      });
      return reply.code(204).send();
    }
  );

  // WHK-04: delivery log per endpoint.
  fastify.get<{ Params: EndpointParams; Querystring: { limit?: string } }>(
    '/api/workspaces/:workspaceSlug/webhooks/:endpointId/deliveries',
    admin,
    async (request) => {
      const limit = Math.min(Math.max(Number(request.query.limit) || 50, 1), 200);
      const deliveries = await fastify.container.withTenant(request.workspace!.id, (tx) =>
        tx.webhookDelivery.findMany({
          where: { webhookEndpointId: request.params.endpointId },
          orderBy: { createdAt: 'desc' },
          take: limit,
        })
      );
      return { deliveries };
    }
  );

  // WHK-08: dead letter queue.
  fastify.get<{ Params: WsParams; Querystring: { includeResolved?: string } }>(
    '/api/workspaces/:workspaceSlug/webhooks/dead-letters',
    admin,
    async (request) => {
      const deadLetters = await fastify.container.withTenant(request.workspace!.id, (tx) =>
        tx.webhookDeadLetter.findMany({
          where: request.query.includeResolved === 'true' ? {} : { resolvedAt: null },
          orderBy: { exhaustedAt: 'desc' },
          take: 200,
        })
      );
      return { deadLetters };
    }
  );

  fastify.post<{
    Params: { workspaceSlug: string; deadLetterId: string };
  }>(
    '/api/workspaces/:workspaceSlug/webhooks/dead-letters/:deadLetterId/retry',
    {
      config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
      preHandler: fastify.requireWorkspace('workspace:admin'),
    },
    async (request, reply) => {
      const { deadLetterId } = request.params;
      const { withTenant, boss } = fastify.container;
      const workspace = request.workspace!;

      if (!boss) {
        reply
          .code(503)
          .send({ error: { code: 'UNAVAILABLE', message: 'Job queue is not available' } });
        return;
      }

      const deadLetter = await withTenant(workspace.id, (tx) =>
        tx.webhookDeadLetter.findFirst({ where: { id: deadLetterId } })
      );

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
      await withTenant(workspace.id, (tx) =>
        tx.webhookDeadLetter.update({
          where: { id: deadLetter.id },
          data: { resolvedAt: new Date(), retriedAt: new Date() },
        })
      );

      reply.code(200).send({ message: 'Dead letter re-enqueued for delivery' });
    }
  );
};

export default webhookRoutes;
