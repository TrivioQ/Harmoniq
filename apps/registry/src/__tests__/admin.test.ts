import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import buildApp from '../app';
import { FastifyInstance } from 'fastify';

describe('Admin Routes', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    process.env.HARMONIQ_SETUP_TOKEN = 'test-token-123';
    process.env.CACHE_ADAPTER = 'memory';
    app = buildApp();
    await app.ready();
    
    // Clear out existing admin if any
    await app.container.db.instanceAdmin.deleteMany();
    await app.container.db.user.deleteMany();
  });

  afterAll(async () => {
    await app.close();
  });

  let adminToken = '';

  it('should initialize admin via setup token', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/admin/setup',
      payload: {
        setupToken: 'test-token-123',
        email: 'admin@harmoniq.local',
        name: 'System Admin'
      }
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.token).toBeDefined();
    expect(body.user.email).toBe('admin@harmoniq.local');
    adminToken = body.token;
  });

  it('should reject setup if already initialized', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/admin/setup',
      payload: {
        setupToken: 'test-token-123',
        email: 'admin2@harmoniq.local'
      }
    });

    expect(res.statusCode).toBe(400);
  });

  it('should reject setup with invalid token', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/admin/setup',
      payload: {
        setupToken: 'wrong-token',
        email: 'admin3@harmoniq.local'
      }
    });

    expect(res.statusCode).toBe(403);
  });

  it('should get system health as admin', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/admin/health',
      headers: {
        Authorization: `Bearer ${adminToken}`
      }
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.status).toBe('ok');
    expect(body.stats).toBeDefined();
  });

  it('should reject system health without token', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/admin/health',
    });

    expect(res.statusCode).toBe(401);
  });
});
