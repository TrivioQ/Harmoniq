import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { connect } from 'http2';
import { get } from 'https';
import { AddressInfo } from 'net';
import selfsigned from 'selfsigned';
import { FastifyInstance } from 'fastify';
import { buildApp } from '../app';
import { Fixtures, bearer } from './helpers/fixtures';

describe('Write rate limits and HTTP/2', () => {
  let app: FastifyInstance | undefined;
  const saved = { ...process.env };

  afterEach(async () => {
    await app?.close();
    app = undefined;
    process.env = { ...saved };
  });

  it('limits writes per credential unless a route sets its own limit', async () => {
    process.env.HARMONIQ_WRITE_RATE_LIMIT = '3';
    app = await buildApp();
    await app.ready();
    const fx = new Fixtures(app);
    const [a, b] = await Promise.all([fx.user(), fx.user()]);
    const [first, second] = await Promise.all([fx.session(a), fx.session(b)]);
    // Invalid bodies: the limit runs before validation, and nothing is created.
    const create = (token: string) =>
      app!.inject({ method: 'POST', url: '/api/workspaces', headers: bearer(token), payload: {} });

    for (let i = 0; i < 3; i++) expect((await create(first)).statusCode).toBe(400);
    const limited = await create(first);
    expect(limited.statusCode).toBe(429);
    expect(limited.headers['retry-after']).toBeDefined();
    // Another credential has its own budget; reads are not limited by it.
    expect((await create(second)).statusCode).toBe(400);
    expect(
      (await app.inject({ method: 'GET', url: '/api/me', headers: bearer(first) })).statusCode
    ).toBe(200);
    await fx.cleanup();
  });

  it.skipIf(!process.env.REDIS_URL)('shares the limits across replicas with Redis', async () => {
    process.env.HARMONIQ_WRITE_RATE_LIMIT = '2';
    process.env.CACHE_ADAPTER = 'redis';
    app = await buildApp();
    const replica = await buildApp();
    try {
      await Promise.all([app.ready(), replica.ready()]);
      // A credential no other run uses (the counters live in Redis for a minute).
      const headers = { authorization: `Bearer hq_rl${Date.now()}_x` };
      const write = (on: FastifyInstance) =>
        on.inject({ method: 'POST', url: '/api/workspaces', headers, payload: {} });
      expect((await write(app)).statusCode).toBe(401);
      expect((await write(replica)).statusCode).toBe(401);
      expect((await write(app)).statusCode).toBe(429);
    } finally {
      await replica.close();
    }
  });

  it('serves HTTP/2 and HTTP/1.1 over TLS when a certificate is configured', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'harmoniq-tls-'));
    try {
      const pems = await selfsigned.generate([{ name: 'commonName', value: 'localhost' }], {
        keySize: 2048,
        notAfterDate: new Date(Date.now() + 24 * 60 * 60 * 1000),
      });
      await writeFile(join(dir, 'cert.pem'), pems.cert);
      await writeFile(join(dir, 'key.pem'), pems.private);
      process.env.TLS_CERT_FILE = join(dir, 'cert.pem');
      process.env.TLS_KEY_FILE = join(dir, 'key.pem');
      app = await buildApp();
      await app.listen({ port: 0, host: '127.0.0.1' });
      const { port } = app.server.address() as AddressInfo;

      const h2 = await new Promise<{ status: number; body: string }>((resolve, reject) => {
        const session = connect(`https://127.0.0.1:${port}`, { rejectUnauthorized: false });
        session.on('error', reject);
        const req = session.request({ ':path': '/health' });
        let status = 0;
        let body = '';
        req.on('response', (headers) => (status = Number(headers[':status'])));
        req.on('data', (chunk) => (body += chunk));
        req.on('end', () => {
          session.close();
          resolve({ status, body });
        });
        req.end();
      });
      expect(h2.status).toBe(200);
      expect(JSON.parse(h2.body)).toMatchObject({ status: 'ok' });

      const h1 = await new Promise<{ status: number; version: string }>((resolve, reject) => {
        get(`https://127.0.0.1:${port}/health`, { rejectUnauthorized: false }, (res) => {
          res.resume();
          resolve({ status: res.statusCode ?? 0, version: res.httpVersion });
        }).on('error', reject);
      });
      expect(h1).toEqual({ status: 200, version: '1.1' });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
