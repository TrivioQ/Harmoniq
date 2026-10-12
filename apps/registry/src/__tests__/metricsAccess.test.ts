// Copyright The Harmoniq Authors
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, afterEach } from 'vitest';
import { AddressInfo } from 'net';
import { FastifyInstance } from 'fastify';
import { buildApp } from '../app';

// INST-25: /metrics can require a token, and doesn't name tenants unless asked to.
describe('Metrics access (INST-25)', () => {
  let app: FastifyInstance | undefined;
  const saved = {
    token: process.env.HARMONIQ_METRICS_TOKEN,
    labels: process.env.HARMONIQ_METRICS_TENANT_LABELS,
    port: process.env.HARMONIQ_METRICS_PORT,
  };
  const restore = (name: string, value: string | undefined) => {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  };
  const start = async (env: { token?: string; labels?: string; port?: string }) => {
    restore('HARMONIQ_METRICS_TOKEN', env.token);
    restore('HARMONIQ_METRICS_TENANT_LABELS', env.labels);
    restore('HARMONIQ_METRICS_PORT', env.port);
    app = await buildApp();
    await app.ready();
    return app;
  };
  const scrape = (a: FastifyInstance, authorization?: string) =>
    a.inject({ method: 'GET', url: '/metrics', headers: authorization ? { authorization } : {} });

  afterEach(async () => {
    await app?.close();
    app = undefined;
    restore('HARMONIQ_METRICS_TOKEN', saved.token);
    restore('HARMONIQ_METRICS_TENANT_LABELS', saved.labels);
    restore('HARMONIQ_METRICS_PORT', saved.port);
  });

  it('requires the bearer token when one is configured', async () => {
    const a = await start({ token: 'scrape-token-0123456789' });
    expect((await scrape(a)).statusCode).toBe(401);
    expect((await scrape(a, 'Bearer wrong-token-0123456789')).statusCode).toBe(401);
    const ok = await scrape(a, 'Bearer scrape-token-0123456789');
    expect(ok.statusCode).toBe(200);
    expect(ok.body).toContain('# HELP');
  });

  it('stays open without a token (e.g. scraped on a private network)', async () => {
    const a = await start({});
    expect((await scrape(a)).statusCode).toBe(200);
  });

  it('treats an empty token as unset and refuses a short one', async () => {
    const a = await start({ token: '' });
    expect((await scrape(a)).statusCode).toBe(200);
    await a.close();
    app = undefined;
    await expect(start({ token: 'short' })).rejects.toThrow('at least 16 characters');
  });

  it('leaves workspace slugs out of labels by default', async () => {
    const a = await start({});
    a.metricMeters.manifestRateLimited.add(1, { workspace: 'acme-secret-team' });
    const body = (await scrape(a)).body;
    expect(body).toContain('rate_limited_total');
    expect(body).not.toContain('acme-secret-team');
  });

  it('labels by workspace when tenant labels are enabled', async () => {
    const a = await start({ labels: '1' });
    a.metricMeters.manifestRateLimited.add(1, { workspace: 'acme-secret-team' });
    expect((await scrape(a)).body).toContain('workspace="acme-secret-team"');
  });

  it('serves metrics on a separate port only, with the token', async () => {
    const a = await start({ port: '0', token: 'scrape-token-0123456789' });
    expect((await scrape(a, 'Bearer scrape-token-0123456789')).statusCode).toBe(404);
    const { port } = a.metricsServer!.address() as AddressInfo;
    const url = `http://127.0.0.1:${port}/metrics`;
    expect((await fetch(url)).status).toBe(401);
    const ok = await fetch(url, { headers: { authorization: 'Bearer scrape-token-0123456789' } });
    expect(ok.status).toBe(200);
    expect(await ok.text()).toContain('# HELP');
    expect((await fetch(`http://127.0.0.1:${port}/other`)).status).toBe(404);
  });
});
