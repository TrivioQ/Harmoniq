// Copyright The Harmoniq Authors
// SPDX-License-Identifier: Apache-2.0

import { randomBytes } from 'crypto';
import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { NotificationChannel, OrgWebhookEndpoint, Prisma } from '@prisma/client';
import type { TenantTx } from '@harmoniq/db';
import { BadRequestError, NotFoundError } from '@harmoniq/core/dist/errors/AppError';
import {
  CreateNotificationChannelSchema,
  CreateOrgWebhookSchema,
  UpdateNotificationChannelSchema,
  UpdateOrgWebhookSchema,
} from '@harmoniq/core/dist/schemas/OrgEventsSchema';
import { sealSecret } from '../services/crypto';
import { checkPublicUrl } from '../services/outbound';
import { ORG_WEBHOOK_QUEUE } from '../services/orgEvents';

type OrgParams = { orgSlug: string };
type Handler = (request: FastifyRequest, reply: FastifyReply) => Promise<unknown>;
type OrgAudit = (
  request: FastifyRequest,
  event: {
    action: string;
    resourceType: string;
    resourceId: string;
    metadata?: Record<string, unknown>;
  },
  tx?: TenantTx
) => Promise<unknown>;

const webhookDto = (e: OrgWebhookEndpoint) => ({
  id: e.id,
  url: e.url,
  events: e.events,
  active: e.active,
  paused: e.paused,
  maxRetries: e.maxRetries,
  createdAt: e.createdAt.toISOString(),
});

const channelDto = (c: NotificationChannel) => ({
  id: c.id,
  kind: c.kind,
  name: c.name,
  // Emails are shown; incoming-webhook URLs are secrets (sealed, never returned).
  target: c.kind === 'email' ? c.target : null,
  events: c.events,
  active: c.active,
  lastSentAt: c.lastSentAt?.toISOString() ?? null,
  lastError: c.lastError,
  createdAt: c.createdAt.toISOString(),
});

/** TAD-09/10: an organization's webhooks and notification channels (org admins). */
export function orgEventRoutes(
  fastify: FastifyInstance,
  deps: { admin: { preHandler: Handler }; orgAudit: OrgAudit }
) {
  const { withOrg } = fastify.container;
  const { encryptionKey } = fastify.config;
  const inOrg = <T>(request: FastifyRequest, fn: (tx: TenantTx) => Promise<T>) =>
    withOrg(request.org!.id, fn);
  const { admin } = deps;
  const allowHttp = !fastify.config.isProduction;

  async function assertPublic(url: string, what: string) {
    const blocked = await checkPublicUrl(url, { allowHttp });
    if (blocked) throw new BadRequestError(`${what} rejected: ${blocked}`);
  }

  // ─── Webhooks (TAD-10) ────────────────────────────────────────────────────

  fastify.get<{ Params: OrgParams }>('/api/orgs/:orgSlug/webhooks', admin, async (request) => {
    const { endpoints, last } = await inOrg(request, async (tx) => {
      const endpoints = await tx.orgWebhookEndpoint.findMany({ orderBy: { createdAt: 'asc' } });
      const last = await Promise.all(
        endpoints.map((e) =>
          tx.orgWebhookDelivery.findFirst({
            where: { endpointId: e.id },
            orderBy: { createdAt: 'desc' },
            select: { success: true, statusCode: true, createdAt: true },
          })
        )
      );
      return { endpoints, last };
    });
    return {
      endpoints: endpoints.map((e, i) => ({
        ...webhookDto(e),
        lastDelivery: last[i] ? { ...last[i], createdAt: last[i]!.createdAt.toISOString() } : null,
      })),
    };
  });

  fastify.post<{ Params: OrgParams }>(
    '/api/orgs/:orgSlug/webhooks',
    admin,
    async (request, reply) => {
      const body = CreateOrgWebhookSchema.parse(request.body);
      await assertPublic(body.url, 'Webhook URL');
      // Shown once; sealed at rest (WHK-05).
      const secret = `whsec_${randomBytes(32).toString('base64url')}`;
      const endpoint = await inOrg(request, async (tx) => {
        const created = await tx.orgWebhookEndpoint.create({
          data: {
            organizationId: request.org!.id,
            url: body.url,
            events: body.events,
            secret: sealSecret(secret, encryptionKey),
          },
        });
        await deps.orgAudit(
          request,
          {
            action: 'org.webhook_create',
            resourceType: 'org_webhook',
            resourceId: created.id,
            metadata: { url: body.url, events: body.events },
          },
          tx
        );
        return created;
      });
      return reply.code(201).send({ ...webhookDto(endpoint), secret });
    }
  );

  fastify.patch<{ Params: OrgParams & { id: string } }>(
    '/api/orgs/:orgSlug/webhooks/:id',
    admin,
    async (request) => {
      const body = UpdateOrgWebhookSchema.parse(request.body);
      if (body.url) await assertPublic(body.url, 'Webhook URL');
      return inOrg(request, async (tx) => {
        const found = await tx.orgWebhookEndpoint.findFirst({ where: { id: request.params.id } });
        if (!found) throw new NotFoundError('Webhook not found');
        const updated = await tx.orgWebhookEndpoint.update({ where: { id: found.id }, data: body });
        await deps.orgAudit(
          request,
          {
            action: 'org.webhook_update',
            resourceType: 'org_webhook',
            resourceId: found.id,
            metadata: body,
          },
          tx
        );
        return webhookDto(updated);
      });
    }
  );

  fastify.delete<{ Params: OrgParams & { id: string } }>(
    '/api/orgs/:orgSlug/webhooks/:id',
    admin,
    async (request, reply) => {
      await inOrg(request, async (tx) => {
        const { count } = await tx.orgWebhookEndpoint.deleteMany({
          where: { id: request.params.id },
        });
        if (!count) throw new NotFoundError('Webhook not found');
        await deps.orgAudit(
          request,
          {
            action: 'org.webhook_delete',
            resourceType: 'org_webhook',
            resourceId: request.params.id,
          },
          tx
        );
      });
      return reply.code(204).send();
    }
  );

  fastify.get<{ Params: OrgParams & { id: string } }>(
    '/api/orgs/:orgSlug/webhooks/:id/deliveries',
    admin,
    async (request) => {
      const deliveries = await inOrg(request, (tx) =>
        tx.orgWebhookDelivery.findMany({
          where: { endpointId: request.params.id },
          orderBy: { createdAt: 'desc' },
          take: 50,
        })
      );
      return {
        deliveries: deliveries.map((d) => ({
          id: d.id,
          event: d.event,
          attempt: d.attempt,
          statusCode: d.statusCode,
          success: d.success,
          durationMs: d.durationMs,
          createdAt: d.createdAt.toISOString(),
        })),
      };
    }
  );

  fastify.get<{ Params: OrgParams }>(
    '/api/orgs/:orgSlug/webhooks-dead-letters',
    admin,
    async (request) => {
      const letters = await inOrg(request, (tx) =>
        tx.orgWebhookDeadLetter.findMany({ orderBy: { exhaustedAt: 'desc' }, take: 100 })
      );
      return {
        deadLetters: letters.map((l) => ({
          id: l.id,
          endpointId: l.endpointId,
          event: l.event,
          totalAttempts: l.totalAttempts,
          finalStatusCode: l.finalStatusCode,
          finalResponseBody: l.finalResponseBody,
          exhaustedAt: l.exhaustedAt.toISOString(),
          retriedAt: l.retriedAt?.toISOString() ?? null,
        })),
      };
    }
  );

  fastify.post<{ Params: OrgParams & { id: string } }>(
    '/api/orgs/:orgSlug/webhooks-dead-letters/:id/retry',
    admin,
    async (request) => {
      const letter = await inOrg(request, async (tx) => {
        const found = await tx.orgWebhookDeadLetter.findFirst({ where: { id: request.params.id } });
        if (!found) throw new NotFoundError('Dead letter not found');
        await tx.orgWebhookDeadLetter.update({
          where: { id: found.id },
          data: { retriedAt: new Date() },
        });
        return found;
      });
      const now = new Date().toISOString();
      await fastify.container.boss?.send(ORG_WEBHOOK_QUEUE, {
        workspaceId: letter.organizationId,
        webhookEndpointId: letter.endpointId,
        event: letter.event,
        payload: letter.payload as Record<string, unknown>,
        attempt: 0,
        firstAttemptAt: now,
      });
      return { id: letter.id, retried: true, queued: !!fastify.container.boss };
    }
  );

  // ─── Notification channels (TAD-09) ───────────────────────────────────────

  fastify.get<{ Params: OrgParams }>('/api/orgs/:orgSlug/notifications', admin, async (request) => {
    const channels = await inOrg(request, (tx) =>
      tx.notificationChannel.findMany({ orderBy: { createdAt: 'asc' } })
    );
    return { channels: channels.map(channelDto) };
  });

  fastify.post<{ Params: OrgParams }>(
    '/api/orgs/:orgSlug/notifications',
    admin,
    async (request, reply) => {
      const body = CreateNotificationChannelSchema.parse(request.body);
      let target: string;
      if (body.kind === 'email') {
        target = [...new Set(body.emails.map((e) => e.trim().toLowerCase()))].join(', ');
      } else {
        await assertPublic(body.url, 'Incoming-webhook URL');
        target = sealSecret(body.url, encryptionKey);
      }
      const channel = await inOrg(request, async (tx) => {
        const created = await tx.notificationChannel.create({
          data: {
            organizationId: request.org!.id,
            kind: body.kind,
            name: body.name,
            target,
            events: body.events,
          },
        });
        await deps.orgAudit(
          request,
          {
            action: 'org.notification_create',
            resourceType: 'notification_channel',
            resourceId: created.id,
            metadata: { kind: body.kind, name: body.name, events: body.events },
          },
          tx
        );
        return created;
      });
      return reply.code(201).send(channelDto(channel));
    }
  );

  fastify.patch<{ Params: OrgParams & { id: string } }>(
    '/api/orgs/:orgSlug/notifications/:id',
    admin,
    async (request) => {
      const body = UpdateNotificationChannelSchema.parse(request.body);
      return inOrg(request, async (tx) => {
        const found = await tx.notificationChannel.findFirst({ where: { id: request.params.id } });
        if (!found) throw new NotFoundError('Channel not found');
        const updated = await tx.notificationChannel.update({
          where: { id: found.id },
          data: body as Prisma.NotificationChannelUpdateInput,
        });
        await deps.orgAudit(
          request,
          {
            action: 'org.notification_update',
            resourceType: 'notification_channel',
            resourceId: found.id,
            metadata: body,
          },
          tx
        );
        return channelDto(updated);
      });
    }
  );

  fastify.delete<{ Params: OrgParams & { id: string } }>(
    '/api/orgs/:orgSlug/notifications/:id',
    admin,
    async (request, reply) => {
      await inOrg(request, async (tx) => {
        const { count } = await tx.notificationChannel.deleteMany({
          where: { id: request.params.id },
        });
        if (!count) throw new NotFoundError('Channel not found');
        await deps.orgAudit(
          request,
          {
            action: 'org.notification_delete',
            resourceType: 'notification_channel',
            resourceId: request.params.id,
          },
          tx
        );
      });
      return reply.code(204).send();
    }
  );

  /** Sends a sample message now, and says whether it went through. */
  fastify.post<{ Params: OrgParams & { id: string } }>(
    '/api/orgs/:orgSlug/notifications/:id/test',
    admin,
    async (request) => {
      const found = await inOrg(request, (tx) =>
        tx.notificationChannel.findFirst({ where: { id: request.params.id } })
      );
      if (!found) throw new NotFoundError('Channel not found');
      try {
        await fastify.container.orgEvents.notify({
          channelId: found.id,
          event: 'org.policy.updated',
          body: {
            event: 'org.policy.updated',
            organization: request.org!.slug,
            fields: ['(test message)'],
          },
        });
        return { ok: true };
      } catch (err) {
        return { ok: false, error: (err as Error).message };
      }
    }
  );
}
