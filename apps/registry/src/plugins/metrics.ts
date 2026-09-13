import fp from 'fastify-plugin';
import { FastifyPluginAsync } from 'fastify';
import { MeterProvider } from '@opentelemetry/sdk-metrics';
import { PrometheusExporter } from '@opentelemetry/exporter-prometheus';
import { metrics, Counter } from '@opentelemetry/api';

declare module 'fastify' {
  interface FastifyInstance {
    metricMeters: {
      manifestCacheHits: Counter;
      manifestCacheMisses: Counter;
      deployCount: Counter;
    };
  }
}

const metricsPlugin: FastifyPluginAsync = async (fastify, _options) => {
  const exporter = new PrometheusExporter({ preventServerStart: true });

  const meterProvider = new MeterProvider({
    readers: [exporter],
  });
  metrics.setGlobalMeterProvider(meterProvider);

  const meter = metrics.getMeter('harmoniq-registry');

  const manifestCacheHits = meter.createCounter('harmoniq_manifest_cache_hits', {
    description: 'Number of cache hits for manifest requests',
  });

  const manifestCacheMisses = meter.createCounter('harmoniq_manifest_cache_misses', {
    description: 'Number of cache misses for manifest requests',
  });

  const deployCount = meter.createCounter('harmoniq_deploy_count', {
    description: 'Number of successful module deployments',
  });

  fastify.decorate('metricMeters', {
    manifestCacheHits,
    manifestCacheMisses,
    deployCount,
  });

  fastify.get('/metrics', async (request, reply) => {
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
