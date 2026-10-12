// Copyright The Harmoniq Authors
// SPDX-License-Identifier: Apache-2.0

import fp from 'fastify-plugin';
import { createHash, timingSafeEqual } from 'crypto';
import { IncomingMessage, Server, ServerResponse, createServer } from 'http';
import { AddressInfo } from 'net';
import { FastifyPluginAsync } from 'fastify';
import { MeterProvider } from '@opentelemetry/sdk-metrics';
import { PrometheusExporter } from '@opentelemetry/exporter-prometheus';
import { metrics, Attributes, Counter } from '@opentelemetry/api';

declare module 'fastify' {
  interface FastifyInstance {
    metricMeters: {
      manifestCacheHits: Counter;
      manifestCacheMisses: Counter;
      deployCount: Counter;
      manifestRateLimited: Counter;
    };
    /** INST-25: the separate metrics listener (`HARMONIQ_METRICS_PORT`), when configured. */
    metricsServer: Server | null;
  }
}

/** Constant-time comparison of a bearer token (hashed first, so lengths always match). */
function tokenMatches(header: string | undefined, expected: string): boolean {
  const given = header?.startsWith('Bearer ') ? header.slice('Bearer '.length).trim() : '';
  const digest = (v: string) => createHash('sha256').update(v).digest();
  return timingSafeEqual(digest(given), digest(expected));
}

const metricsPlugin: FastifyPluginAsync = async (fastify, _options) => {
  const { token, tenantLabels, port } = fastify.config.metrics;
  const exporter = new PrometheusExporter({ preventServerStart: true });

  const meterProvider = new MeterProvider({
    readers: [exporter],
  });
  metrics.setGlobalMeterProvider(meterProvider);

  // This app's own provider: the global one is set once per process, so a second app (tests)
  // would otherwise record into the first one's exporter.
  const meter = meterProvider.getMeter('harmoniq-registry');

  const manifestCacheHits = meter.createCounter('harmoniq_manifest_cache_hits', {
    description: 'Number of cache hits for manifest requests',
  });

  const manifestCacheMisses = meter.createCounter('harmoniq_manifest_cache_misses', {
    description: 'Number of cache misses for manifest requests',
  });

  const deployCount = meter.createCounter('harmoniq_deploy_count', {
    description: 'Number of successful module deployments',
  });

  // RL-05. INST-25: by workspace slug only when tenant labels are enabled.
  const rateLimitedCounter = meter.createCounter('harmoniq.manifest.rate_limited_total', {
    description: 'Manifest requests rejected by the rate limiter (by workspace slug when enabled)',
  });
  const manifestRateLimited = {
    add: (value: number, attributes?: Attributes) =>
      rateLimitedCounter.add(value, tenantLabels ? attributes : undefined),
  } as Counter;

  // Request durations by route and status, for latency dashboards and alerts.
  const requestDuration = meter.createHistogram('harmoniq_http_request_duration_ms', {
    description: 'HTTP request duration in milliseconds',
    unit: 'ms',
  });
  fastify.addHook('onResponse', async (request, reply) => {
    const route = request.routeOptions.url;
    if (!route || route === '/metrics') return;
    requestDuration.record(reply.elapsedTime, {
      method: request.method,
      route,
      status: reply.statusCode,
    });
  });

  fastify.decorate('metricMeters', {
    manifestRateLimited,
    manifestCacheHits,
    manifestCacheMisses,
    deployCount,
  });

  /** Serves the Prometheus text format; INST-25: requires the scrape token when configured. */
  const serve = (req: IncomingMessage, res: ServerResponse) => {
    if (token && !tokenMatches(req.headers.authorization, token)) {
      res.writeHead(401, { 'content-type': 'application/json', 'www-authenticate': 'Bearer' });
      res.end(
        JSON.stringify({ error: { code: 'UNAUTHORIZED', message: 'A metrics token is required' } })
      );
      return;
    }
    exporter.getMetricsRequestHandler(req, res);
  };

  if (!token && port === undefined && fastify.config.isProduction) {
    fastify.log.warn(
      'GET /metrics is public: set HARMONIQ_METRICS_TOKEN or HARMONIQ_METRICS_PORT, or keep the registry port off the internet'
    );
  }

  fastify.decorate('metricsServer', null);
  if (port !== undefined) {
    // INST-25: a separate listener (e.g. reachable only inside the cluster); the API port has
    // no /metrics then.
    const server = createServer((req, res) => {
      if (req.method === 'GET' && req.url?.split('?')[0] === '/metrics') return serve(req, res);
      res.writeHead(404).end();
    });
    fastify.metricsServer = server;
    fastify.addHook('onReady', async () => {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, () => {
          fastify.log.info(`Metrics on port ${(server.address() as AddressInfo).port}`);
          resolve();
        });
      });
    });
    fastify.addHook('onClose', async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    });
    return;
  }

  fastify.get('/metrics', async (request, reply) => {
    reply.hijack();
    await new Promise((resolve) => {
      reply.raw.on('finish', resolve);
      serve(request.raw, reply.raw);
    });
  });
};

export default fp(metricsPlugin, {
  name: 'app-metrics',
});
