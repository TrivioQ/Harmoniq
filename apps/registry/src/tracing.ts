// Copyright The Harmoniq Authors
// SPDX-License-Identifier: Apache-2.0

/**
 * OpenTelemetry tracing, started before anything else is imported so HTTP, Fastify,
 * Postgres and Redis are instrumented. Off unless an OTLP endpoint is configured
 * (OTEL_EXPORTER_OTLP_ENDPOINT or OTEL_EXPORTER_OTLP_TRACES_ENDPOINT); every other
 * standard OTEL_* variable (service name, headers, sampler) applies as usual.
 */
import { NodeSDK } from '@opentelemetry/sdk-node';
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';

const endpoint =
  process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT ?? process.env.OTEL_EXPORTER_OTLP_ENDPOINT;

if (endpoint && process.env.NODE_ENV !== 'test') {
  process.env.OTEL_SERVICE_NAME ??= 'harmoniq-registry';
  const sdk = new NodeSDK({
    traceExporter: new OTLPTraceExporter(),
    instrumentations: [
      getNodeAutoInstrumentations({
        // Noisy and not useful for a service.
        '@opentelemetry/instrumentation-fs': { enabled: false },
        '@opentelemetry/instrumentation-dns': { enabled: false },
        '@opentelemetry/instrumentation-net': { enabled: false },
      }),
    ],
  });
  sdk.start();
  const shutdown = () => void sdk.shutdown().catch(() => undefined);
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
}
