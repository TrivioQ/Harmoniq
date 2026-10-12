// Copyright The Harmoniq Authors
// SPDX-License-Identifier: Apache-2.0

import fp from 'fastify-plugin';
import { createHash, timingSafeEqual } from 'crypto';
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
  }
}

/** Constant-time comparison of a bearer token (hashed first, so lengths always match). */
function tokenMatches(header: string | undefined, expected: string): boolean {
  const given = header?.startsWith('Bearer ') ? header.slice('Bearer '.length).trim() : '';
  const digest = (v: string) => createHash('sha256').update(v).digest();
  return timingSafeEqual(digest(given), digest(expected));
}

const metricsPlugin: FastifyPluginAsync = async (fastify, _options) => {
  const { token, tenantLabels } = fastify.config.metrics;
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

  if (!token && fastify.config.isProduction) {
    fastify.log.warn(
      'GET /metrics is public: set HARMONIQ_METRICS_TOKEN, or keep the registry port off the internet'
    );
  }

  fastify.get('/metrics', async (request, reply) => {
    // INST-25: a scrape token, when configured.
    if (token && !tokenMatches(request.headers.authorization, token)) {
      return reply
        .code(401)
        .header('WWW-Authenticate', 'Bearer')
        .send({ error: { code: 'UNAUTHORIZED', message: 'A metrics token is required' } });
    }
    // The PrometheusExporter exposes a request handler for http.Server.
    // We can directly pass the raw node req and res objects.
    await new Promise((resolve) => {
      exporter.getMetricsRequestHandler(request.raw, reply.raw);
      reply.raw.on('finish', resolve);
    });
  });
};

export default fp(metricsPlugin, {
  name: 'app-metrics',
});
