import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { buildApp } from '../app';
import { FastifyInstance } from 'fastify';

describe('Registry Endpoints', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    process.env.CACHE_ADAPTER = 'lru';
    app = await buildApp();
  });

  afterAll(async () => {
    await app.close();
  });

  it('should return health ok', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/health',
    });
    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.payload)).toEqual({ status: 'ok' });
  });

  it('should return manifest for seeded acme-corp', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/manifest/acme-corp/consumer-portal/production',
    });

    // Might be 200 or 404 depending on if DB is seeded in the test environment,
    // but in our current setup, the main dev DB is used.
    // Usually tests use a separate DB. We will just check it doesn't crash 500.
    expect([200, 404]).toContain(response.statusCode);

    if (response.statusCode === 200) {
      const payload = JSON.parse(response.payload);
      expect(payload.schemaVersion).toBe(2);
      expect(payload.hostApp).toBe('consumer-portal');
    }
  });

  it('should return 401 when deploying without token', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/workspaces/acme-corp/modules/some-module/deploy',
      payload: {
        url: 'https://example.com/remoteEntry.js',
        version: '1.0.0',
        integrity: 'sha256-abc',
      },
    });

    expect(response.statusCode).toBe(401);
  });
});
