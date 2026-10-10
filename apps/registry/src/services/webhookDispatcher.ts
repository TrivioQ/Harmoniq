// Copyright The Harmoniq Authors
// SPDX-License-Identifier: Apache-2.0

import type { PgBoss } from 'pg-boss';
import type { TenantTx } from '@harmoniq/db';
import type { ILogger } from '@harmoniq/core/dist/ports/ILogger';
import type { WebhookEventName } from '@harmoniq/core/dist/schemas/WebhookEventSchema';
import type { WebhookJobData } from '../jobs/webhooks';

export interface WebhookDispatcher {
  /** Enqueues the event for every active endpoint subscribed to it (or to `*`). */
  dispatch(
    workspaceId: string,
    event: WebhookEventName,
    payload: Record<string, unknown>
  ): Promise<void>;
}

export function createWebhookDispatcher(deps: {
  boss: PgBoss | null;
  logger: ILogger;
  withTenant: <T>(workspaceId: string, fn: (tx: TenantTx) => Promise<T>) => Promise<T>;
}): WebhookDispatcher {
  return {
    async dispatch(workspaceId, event, payload) {
      // No job queue in tests / when the queue failed to start: nothing to deliver with.
      if (!deps.boss) return;
      // Paused endpoints still get the event queued; delivery skips them (WHK-10).
      const endpoints = await deps.withTenant(workspaceId, (tx) =>
        tx.webhookEndpoint.findMany({
          where: { active: true, events: { hasSome: [event, '*'] } },
          select: { id: true },
        })
      );
      const firstAttemptAt = new Date().toISOString();
      for (const endpoint of endpoints) {
        const job: WebhookJobData = {
          workspaceId,
          webhookEndpointId: endpoint.id,
          event,
          payload: { event, occurredAt: firstAttemptAt, ...payload },
          attempt: 0,
          firstAttemptAt,
        };
        await deps.boss.send('webhook.deliver', job);
      }
    },
  };
}
