import { FastifyInstance } from 'fastify';
import crypto from 'crypto';

export type WebhookJobData = {
  workspaceId: string;
  webhookEndpointId: string;
  event: string;
  payload: any;
  attempt: number;
  firstAttemptAt: string;
};

export async function handleWebhookDelivery(job: any, db: any, logger: any, boss: any) {
  const data = job.data as WebhookJobData;
  const endpoint = await db.webhookEndpoint.findUnique({
    where: { id: data.webhookEndpointId }
  });

  if (!endpoint || !endpoint.active || endpoint.paused) {
    logger.info(`Skipping webhook delivery for endpoint ${data.webhookEndpointId}: inactive or deleted`);
    return;
  }

  const payloadStr = JSON.stringify(data.payload);
  const signature = crypto
    .createHmac('sha256', endpoint.secret)
    .update(payloadStr)
    .digest('hex');

  const startTime = Date.now();
  let success = false;
  let statusCode: number | null = null;
  let responseBody: string | null = null;

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 10000); // 10s timeout

    const res = await fetch(endpoint.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Harmoniq-Signature': signature,
        'X-Harmoniq-Event': data.event
      },
      body: payloadStr,
      signal: controller.signal
    });

    clearTimeout(timeoutId);

    statusCode = res.status;
    success = res.ok;

    if (!success) {
      responseBody = await res.text().catch(() => 'Could not read body');
    }
  } catch (e: any) {
    success = false;
    responseBody = e.message;
  }

  const durationMs = Date.now() - startTime;

  // Log delivery attempt
  await db.webhookDelivery.create({
    data: {
      workspaceId: data.workspaceId,
      webhookEndpointId: endpoint.id,
      event: data.event,
      payload: data.payload,
      attempt: data.attempt,
      statusCode,
      durationMs,
      success
    }
  });

  if (success) {
    logger.info(`Webhook ${data.event} delivered to ${endpoint.url}`);
    return;
  }

  // Handle failure
  if (data.attempt >= endpoint.maxRetries) {
    // Exhausted -> Dead Letter
    await db.webhookDeadLetter.create({
      data: {
        workspaceId: data.workspaceId,
        webhookEndpointId: endpoint.id,
        event: data.event,
        payload: data.payload,
        totalAttempts: data.attempt,
        firstAttemptAt: new Date(data.firstAttemptAt),
        exhaustedAt: new Date(),
        finalStatusCode: statusCode,
        finalResponseBody: responseBody?.substring(0, 1000)
      }
    });
    logger.warn(`Webhook ${data.event} to ${endpoint.url} exhausted and dead-lettered`);
    return; // Do not throw, we handled it
  }

  // Schedule next retry with exponential backoff
  const backoffDelay = Math.min(
    Math.pow(2, data.attempt) * 1000,
    endpoint.backoffCeilingMs
  );

  await boss.send('webhook.deliver', {
    ...data,
    attempt: data.attempt + 1
  }, { startAfter: Math.floor(backoffDelay / 1000) });

  logger.warn(`Webhook ${data.event} to ${endpoint.url} failed. Retrying in ${backoffDelay}ms`);
}

export async function registerWebhookJobs(fastify: FastifyInstance) {
  const boss = fastify.container.boss;
  const db = fastify.container.db;
  const logger = fastify.container.logger;

  if (!boss) return;

  boss.work<WebhookJobData>('webhook.deliver', (job: any) => handleWebhookDelivery(job, db, logger, boss));
}
