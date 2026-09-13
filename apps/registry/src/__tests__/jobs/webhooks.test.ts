import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { handleWebhookDelivery, WebhookJobData, WebhookBoss } from '../../jobs/webhooks';
import { ConsoleLogger } from '../../adapters/ConsoleLogger';
import { setupServer } from 'msw/node';
import { http, HttpResponse } from 'msw';

const server = setupServer();

describe('Webhook Jobs', () => {
  const logger = new ConsoleLogger();

  beforeAll(() => {
    server.listen();
  });

  afterAll(() => {
    server.close();
  });

  it('handleWebhookDelivery should succeed and log delivery on 200 OK', async () => {
    let receivedSignature: string | null = null;
    server.use(
      http.post('https://example.com/webhook', ({ request }) => {
        receivedSignature = request.headers.get('X-Harmoniq-Signature');
        return HttpResponse.json({ success: true }, { status: 200 });
      })
    );

    const db = {
      webhookEndpoint: {
        findUnique: vi.fn().mockResolvedValue({
          id: 'endpoint-1',
          url: 'https://example.com/webhook',
          secret: 'test-secret',
          active: true,
          paused: false,
          maxRetries: 3,
          backoffCeilingMs: 300000,
        }),
      },
      webhookDelivery: {
        create: vi.fn().mockResolvedValue({}),
      },
      webhookDeadLetter: {
        create: vi.fn(),
      },
    };

    const job = {
      data: {
        workspaceId: 'ws-1',
        webhookEndpointId: 'endpoint-1',
        event: 'module.deployed',
        payload: { module: 'test', version: '1.0.0' },
        attempt: 0,
        firstAttemptAt: new Date().toISOString(),
      } as WebhookJobData,
    };

    const boss = { send: vi.fn() } as unknown as WebhookBoss;

    await handleWebhookDelivery(job, db, logger, boss);

    expect(receivedSignature).toBeTruthy();
    expect(db.webhookDelivery.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          success: true,
        }),
      })
    );
    expect(boss.send).not.toHaveBeenCalled();
    expect(db.webhookDeadLetter.create).not.toHaveBeenCalled();
  });

  it('handleWebhookDelivery should retry on 500 error', async () => {
    server.use(
      http.post('https://example.com/webhook-fail', () => {
        return HttpResponse.json({ error: 'fail' }, { status: 500 });
      })
    );

    const db = {
      webhookEndpoint: {
        findUnique: vi.fn().mockResolvedValue({
          id: 'endpoint-2',
          url: 'https://example.com/webhook-fail',
          secret: 'test-secret',
          active: true,
          paused: false,
          maxRetries: 3,
          backoffCeilingMs: 300000,
        }),
      },
      webhookDelivery: {
        create: vi.fn().mockResolvedValue({}),
      },
      webhookDeadLetter: {
        create: vi.fn(),
      },
    };

    const job = {
      data: {
        workspaceId: 'ws-2',
        webhookEndpointId: 'endpoint-2',
        event: 'module.deployed',
        payload: { module: 'test', version: '1.0.0' },
        attempt: 0,
        firstAttemptAt: new Date().toISOString(),
      } as WebhookJobData,
    };

    const boss = { send: vi.fn() } as unknown as WebhookBoss;

    await handleWebhookDelivery(job, db, logger, boss);

    expect(db.webhookDelivery.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          success: false,
        }),
      })
    );
    expect(boss.send).toHaveBeenCalledWith(
      'webhook.deliver',
      expect.objectContaining({
        attempt: 1,
      }),
      expect.any(Object)
    );
    expect(db.webhookDeadLetter.create).not.toHaveBeenCalled();
  });

  it('handleWebhookDelivery should dead-letter on max retries exhausted', async () => {
    server.use(
      http.post('https://example.com/webhook-fail', () => {
        return HttpResponse.json({ error: 'fail' }, { status: 500 });
      })
    );

    const db = {
      webhookEndpoint: {
        findUnique: vi.fn().mockResolvedValue({
          id: 'endpoint-3',
          url: 'https://example.com/webhook-fail',
          secret: 'test-secret',
          active: true,
          paused: false,
          maxRetries: 2,
          backoffCeilingMs: 300000,
        }),
      },
      webhookDelivery: {
        create: vi.fn().mockResolvedValue({}),
      },
      webhookDeadLetter: {
        create: vi.fn().mockResolvedValue({}),
      },
    };

    const job = {
      data: {
        workspaceId: 'ws-3',
        webhookEndpointId: 'endpoint-3',
        event: 'module.deployed',
        payload: { module: 'test', version: '1.0.0' },
        attempt: 2, // Reached max retries
        firstAttemptAt: new Date().toISOString(),
      } as WebhookJobData,
    };

    const boss = { send: vi.fn() } as unknown as WebhookBoss;

    await handleWebhookDelivery(job, db, logger, boss);

    expect(db.webhookDelivery.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          success: false,
        }),
      })
    );
    expect(db.webhookDeadLetter.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          totalAttempts: 2,
        }),
      })
    );
    expect(boss.send).not.toHaveBeenCalled();
  });
});
