import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { FastifyInstance } from 'fastify';
import { trace } from '@opentelemetry/api';
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base';
import { buildApp } from '../app';
import { Fixtures } from './helpers/fixtures';

describe('Observability: request ids, metrics, traces', () => {
  let app: FastifyInstance;
  let fx: Fixtures;
  const spans = new InMemorySpanExporter();

  beforeAll(async () => {
    const provider = new BasicTracerProvider();
    provider.addSpanProcessor(new SimpleSpanProcessor(spans));
    trace.setGlobalTracerProvider(provider);
    app = await buildApp();
    await app.ready();
    fx = new Fixtures(app);
  });
  afterAll(async () => {
    trace.disable();
    await fx.cleanup();
    await app.close();
  });

  it('gives every response a request id, keeping a caller’s', async () => {
    const generated = await app.inject({ method: 'GET', url: '/health' });
    expect(generated.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
    const kept = await app.inject({
      method: 'GET',
      url: '/health',
      headers: { 'x-request-id': 'edge-123' },
    });
    expect(kept.headers['x-request-id']).toBe('edge-123');
    const refused = await app.inject({
      method: 'GET',
      url: '/health',
      headers: { 'x-request-id': 'bad id\n' },
    });
    expect(refused.headers['x-request-id']).not.toContain('bad');
  });

  it('traces deploys and manifest builds, and records request durations', async () => {
    const { workspace } = await fx.workspace();
    const key = (await fx.apiKey(workspace.id)).raw;
    const deployed = await app.inject({
      method: 'POST',
      url: `/api/workspaces/${workspace.slug}/modules/checkout/deploy`,
      headers: { authorization: `Bearer ${key}` },
      payload: {
        environment: 'production',
        url: 'https://cdn.example.com/checkout/1.0.0.js',
        version: '1.0.0',
        integrity: 'sha384-abc',
      },
    });
    expect(deployed.statusCode).toBe(201);
    await app.inject({ method: 'GET', url: `/api/manifest/${workspace.slug}/portal/production` });

    const finished = spans.getFinishedSpans();
    const mutation = finished.find((s) => s.name === 'harmoniq.mutation');
    expect(mutation?.attributes).toMatchObject({
      'harmoniq.workspace': workspace.slug,
      'harmoniq.environment': 'production',
      'harmoniq.actor_type': 'apiKey',
    });
    expect(finished.map((s) => s.name)).toContain('harmoniq.manifest.resolve');

    const metrics = await app.inject({ method: 'GET', url: '/metrics' });
    expect(metrics.body).toContain('harmoniq_http_request_duration_ms');
    expect(metrics.body).toMatch(/route="\/api\/manifest\/:workspaceSlug\/:hostAppSlug\/:env"/);
  });
});
