// Copyright The Harmoniq Authors
// SPDX-License-Identifier: Apache-2.0

import type { PgBoss } from 'pg-boss';
import type { PrismaClient } from '@prisma/client';
import type { ILogger } from '@harmoniq/core/dist/ports/ILogger';
import type { IMailer } from '@harmoniq/core/dist/ports/IMailer';
import type { OrgEventName } from '@harmoniq/core/dist/schemas/OrgEventsSchema';
import { openSecret } from './crypto';
import {
  type WebhookBoss,
  type WebhookDb,
  type WebhookDeliveryOptions,
  type WebhookJobData,
  handleWebhookDelivery,
} from '../jobs/webhooks';

export const ORG_WEBHOOK_QUEUE = 'org-webhook.deliver';
export const NOTIFY_QUEUE = 'notify.send';

export type NotifyJobData = {
  channelId: string;
  event: OrgEventName;
  body: Record<string, unknown>;
};

/**
 * TAD-09/10: an organization's events go to its webhooks (signed, retried and dead-lettered
 * like workspace webhooks) and to its notification channels (email, Slack, Teams). `emit`
 * never throws: the change that caused the event has already happened.
 */
export class OrgEvents {
  constructor(
    private deps: {
      systemDb: PrismaClient;
      boss: PgBoss | null;
      logger: ILogger;
      encryptionKey: Buffer;
      mailer: () => IMailer | null;
      instanceName: () => string;
      webOrigin: string;
      /** Fetch for Slack and Teams URLs (the registry's SSRF-guarded fetch). */
      fetchImpl: typeof fetch;
      checkUrl: (url: string) => Promise<string | null>;
    }
  ) {}

  async emit(organizationId: string, event: OrgEventName, payload: Record<string, unknown>) {
    try {
      const { systemDb, boss } = this.deps;
      const org = await systemDb.organization.findUnique({
        where: { id: organizationId },
        select: { slug: true },
      });
      if (!org) return;
      const occurredAt = new Date().toISOString();
      const body = { event, occurredAt, organization: org.slug, ...payload };
      const subscribed = { active: true, events: { hasSome: [event, '*'] } };
      const [endpoints, channels] = await Promise.all([
        systemDb.orgWebhookEndpoint.findMany({
          where: { organizationId, ...subscribed },
          select: { id: true },
        }),
        systemDb.notificationChannel.findMany({
          where: { organizationId, ...subscribed },
          select: { id: true },
        }),
      ]);
      if (boss) {
        for (const e of endpoints) {
          const job: WebhookJobData = {
            workspaceId: organizationId,
            webhookEndpointId: e.id,
            event,
            payload: body,
            attempt: 0,
            firstAttemptAt: occurredAt,
          };
          await boss.send(ORG_WEBHOOK_QUEUE, job);
        }
        for (const c of channels) {
          await boss.send(NOTIFY_QUEUE, { channelId: c.id, event, body } satisfies NotifyJobData, {
            retryLimit: 3,
            retryBackoff: true,
          });
        }
      } else {
        // No job queue (tests, or the queue failed to start): notify inline, best effort.
        for (const c of channels)
          await this.notify({ channelId: c.id, event, body }).catch(() => {});
      }
    } catch (err) {
      this.deps.logger.warn(`Org event ${event} not sent: ${(err as Error).message}`);
    }
  }

  /** One message to one channel; records the outcome on the channel. Throws to retry. */
  async notify(job: NotifyJobData) {
    const { systemDb } = this.deps;
    const channel = await systemDb.notificationChannel.findUnique({ where: { id: job.channelId } });
    if (!channel || !channel.active) return;
    const text = describeOrgEvent(job.event, job.body);
    const link = `${this.deps.webOrigin.replace(/\/$/, '')}/orgs/${String(job.body.organization)}`;
    try {
      if (channel.kind === 'email') {
        const mailer = this.deps.mailer();
        if (!mailer) throw new Error('Outbound email is not configured');
        await mailer.send({
          to: channel.target,
          subject: `${this.deps.instanceName()}: ${text}`,
          text: `${text}\n\n${link}`,
        });
      } else {
        const url = openSecret(channel.target, this.deps.encryptionKey);
        const blocked = await this.deps.checkUrl(url);
        if (blocked) throw new Error(`Blocked: ${blocked}`);
        // Slack and Teams incoming webhooks both take `{ text }`.
        const res = await this.deps.fetchImpl(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text: `${text} (${link})` }),
          signal: AbortSignal.timeout(10_000),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
      }
      await systemDb.notificationChannel.update({
        where: { id: channel.id },
        data: { lastSentAt: new Date(), lastError: null },
      });
    } catch (err) {
      await systemDb.notificationChannel.update({
        where: { id: channel.id },
        data: { lastError: (err as Error).message.slice(0, 500) },
      });
      throw err;
    }
  }
}

/** One line for a person (notifications): what happened, in the organization. */
export function describeOrgEvent(event: OrgEventName, body: Record<string, unknown>) {
  const s = (key: string) => String(body[key] ?? '');
  const org = s('organization');
  const where = body.workspace ? `${s('workspace')} (${org})` : org;
  switch (event) {
    case 'org.member.added':
      return `${s('email')} joined ${org} as ${s('role')}`;
    case 'org.member.removed':
      return `${s('email')} left ${org}`;
    case 'org.member.role_changed':
      return `${s('email')} is now ${s('role')} in ${org}`;
    case 'org.workspace.created':
    case 'org.workspace.deleted':
    case 'org.workspace.restored':
    case 'org.workspace.attached':
    case 'org.workspace.detached':
      return `Workspace ${s('workspace')} was ${event.split('.')[2]} in ${org}`;
    case 'org.key.created':
    case 'org.key.revoked':
    case 'org.key.rotated':
      return `API key "${s('name')}" was ${event.split('.')[2]} in ${org}`;
    case 'org.policy.updated':
      return `The policy of ${org} changed: ${((body.fields as string[]) ?? []).join(', ')}`;
    case 'quota.warning':
      return `${where} is at 80% of its ${s('quota')} quota (${s('used')} of ${s('limit')})`;
    case 'quota.exceeded':
      return `${where} reached its ${s('quota')} quota (${s('limit')})`;
    case 'plan.changed':
      return `The plan of ${where} changed from ${s('from')} to ${s('to')}`;
    case 'deploy.approval_requested':
      return `${where}: a ${s('type')} to ${s('environment')} is waiting for approval`;
    case 'domain.verification_lost':
      return `${s('domain')} is no longer verified for ${where}`;
  }
}

/** TAD-10: the workspace delivery engine (WHK), on the organization's tables. */
export function handleOrgWebhookDelivery(
  job: { data: WebhookJobData },
  db: PrismaClient,
  logger: ILogger,
  boss: WebhookBoss,
  opts: WebhookDeliveryOptions
) {
  const adapter: WebhookDb = {
    webhookEndpoint: {
      findUnique: ({ where }) => db.orgWebhookEndpoint.findUnique({ where }),
    },
    webhookDelivery: {
      create: ({ data }) =>
        db.orgWebhookDelivery.create({
          data: {
            organizationId: data.workspaceId,
            endpointId: data.webhookEndpointId,
            event: data.event,
            payload: data.payload,
            statusCode: data.statusCode,
            attempt: data.attempt,
            durationMs: data.durationMs,
            success: data.success,
          },
        }),
    },
    webhookDeadLetter: {
      create: ({ data }) =>
        db.orgWebhookDeadLetter.create({
          data: {
            organizationId: data.workspaceId,
            endpointId: data.webhookEndpointId,
            event: data.event,
            payload: data.payload,
            finalStatusCode: data.finalStatusCode,
            finalResponseBody: data.finalResponseBody,
            totalAttempts: data.totalAttempts,
            firstAttemptAt: data.firstAttemptAt,
            exhaustedAt: data.exhaustedAt,
          },
        }),
    },
  };
  // Retries go back to the organization's queue.
  const orgBoss: WebhookBoss = {
    send: ((_queue: string, data: object, options?: object) =>
      boss.send(ORG_WEBHOOK_QUEUE, data, options)) as WebhookBoss['send'],
  };
  return handleWebhookDelivery(job, adapter, logger, orgBoss, opts);
}
