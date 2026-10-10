import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { buildApp } from '../app';
import { FastifyInstance } from 'fastify';
import { signAccessToken } from '../auth/tokens';

describe('Admin Routes', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    process.env.HARMONIQ_SETUP_TOKEN = 'test-token-123';
    process.env.CACHE_ADAPTER = 'memory';
    app = await buildApp();
    await app.ready();

    // Setup is one-time per instance: reset only the marker, not other tests' data.
    await app.container.systemDb.instanceConfig.deleteMany({ where: { key: 'setup.completed' } });
    await app.container.systemDb.user.deleteMany({
      where: { email: { in: ['admin@harmoniq.local', 'admin2@harmoniq.local'] } },
    });
  });

  afterAll(async () => {
    await app.container.systemDb.instanceConfig.deleteMany({ where: { key: 'setup.completed' } });
    await app.container.systemDb.user.deleteMany({
      where: { email: { in: ['admin@harmoniq.local', 'admin2@harmoniq.local'] } },
    });
    await app.close();
  });

  let adminToken = '';

  it('walks the wizard steps with the setup token (INST-01..03)', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/admin/setup' })).json()).toEqual({
      needed: true,
      tokenConfigured: true,
    });
    const check = await app.inject({
      method: 'POST',
      url: '/api/admin/setup/check',
      payload: { setupToken: 'test-token-123' },
    });
    expect(check.statusCode).toBe(200);
    expect(check.json()).toMatchObject({
      database: { ok: true },
      cache: { ok: true, adapter: 'memory' },
    });
    const storage = await app.inject({
      method: 'POST',
      url: '/api/admin/setup/storage',
      payload: { setupToken: 'test-token-123' },
    });
    expect(storage.json()).toMatchObject({ ok: true });
    for (const url of ['/api/admin/setup/check', '/api/admin/setup/storage']) {
      const wrong = await app.inject({ method: 'POST', url, payload: { setupToken: 'nope' } });
      expect(wrong.statusCode).toBe(403);
    }
  });

  it('should initialize admin via setup token', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/admin/setup',
      payload: {
        setupToken: 'test-token-123',
        email: 'admin@harmoniq.local',
        name: 'System Admin',
      },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    // Setup no longer hands out a session; the admin signs in like any other user.
    expect(body.token).toBeUndefined();
    expect(body.user.email).toBe('admin@harmoniq.local');
    adminToken = await signAccessToken(
      { userId: body.user.id, email: body.user.email },
      app.config.jwtSecret
    );
  });

  it('should reject setup if already initialized', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/admin/setup',
      payload: {
        setupToken: 'test-token-123',
        email: 'admin2@harmoniq.local',
      },
    });

    // INST-02/04: the token is consumed; every setup step is refused from now on.
    expect(res.statusCode).toBe(403);
    expect((await app.inject({ method: 'GET', url: '/api/admin/setup' })).json().needed).toBe(
      false
    );
    const check = await app.inject({
      method: 'POST',
      url: '/api/admin/setup/check',
      payload: { setupToken: 'test-token-123' },
    });
    expect(check.statusCode).toBe(403);
  });

  it('should reject setup with invalid token', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/admin/setup',
      payload: {
        setupToken: 'wrong-token',
        email: 'admin3@harmoniq.local',
      },
    });

    expect(res.statusCode).toBe(403);
  });

  it('should get system health as admin', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/admin/health',
      headers: {
        Authorization: `Bearer ${adminToken}`,
      },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.status).toBe('ok');
    expect(body.stats).toBeDefined();
    // INST-08: every dependency is checked.
    expect(body.checks).toMatchObject({
      database: { ok: true },
      cache: { ok: true },
      storage: { ok: true },
      queue: { ok: true },
    });
  });

  it('should reject system health without token', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/admin/health',
    });

    expect(res.statusCode).toBe(401);
  });
});
