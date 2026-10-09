import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { FastifyInstance } from 'fastify';
import { buildApp } from '../app';
import { Fixtures, bearer } from './helpers/fixtures';

// MAN-01: cached manifests within 50ms p99.
describe('Performance: Manifest Endpoint', () => {
  let app: FastifyInstance;
  let fx: Fixtures;
  let url: string;

  beforeAll(async () => {
    process.env.CACHE_ADAPTER = 'memory';
    // The load test deliberately exceeds the per-client rate limit (RL-01).
    process.env.HARMONIQ_MANIFEST_RATE_LIMIT = '1000000';
    app = await buildApp();
    await app.listen({ port: 0 });
    fx = new Fixtures(app);

    const { workspace } = await fx.workspace();
    const key = (await fx.apiKey(workspace.id)).raw;
    const res = await app.inject({
      method: 'POST',
      url: `/api/workspaces/${workspace.slug}/modules/checkout/deploy`,
      headers: bearer(key),
      payload: {
        environment: 'production',
        url: 'https://cdn.example.com/checkout/1.0.0/remoteEntry.js',
        version: '1.0.0',
        integrity: 'sha384-abc',
      },
    });
    expect(res.statusCode).toBe(201); // the deploy also warms the cache

    const address = app.server.address();
    const port = typeof address === 'string' ? address : address?.port;
    url = `http://127.0.0.1:${port}/api/manifest/${workspace.slug}/portal/production`;
  });

  afterAll(async () => {
    delete process.env.HARMONIQ_MANIFEST_RATE_LIMIT;
    await fx.cleanup();
    await app.close();
  });

  it('serves cached manifests within 50ms p99', async () => {
    // 10 concurrent clients, 2,000 requests, each timed individually.
    const latencies: number[] = [];
    let failures = 0;
    const worker = async () => {
      for (let i = 0; i < 200; i++) {
        const start = performance.now();
        const res = await fetch(url);
        await res.arrayBuffer();
        latencies.push(performance.now() - start);
        if (res.status !== 200) failures++;
      }
    };
    await Promise.all(Array.from({ length: 10 }, worker));

    latencies.sort((a, b) => a - b);
    const p99 = latencies[Math.floor(latencies.length * 0.99) - 1];
    console.log(`manifest p99=${p99.toFixed(2)}ms over ${latencies.length} requests`);
    expect(failures).toBe(0);
    expect(p99).toBeLessThan(50);
  }, 30_000);
});
