import { SpanStatusCode, trace, type Attributes } from '@opentelemetry/api';

const tracer = trace.getTracer('harmoniq-registry');

/**
 * A span around a critical path (manifest builds, mutations, background jobs). Without
 * a configured SDK the tracer is a no-op, so this costs nothing.
 */
export function withSpan<T>(
  name: string,
  attributes: Attributes,
  fn: () => Promise<T>
): Promise<T> {
  return tracer.startActiveSpan(name, { attributes }, async (span) => {
    try {
      return await fn();
    } catch (err) {
      span.recordException(err as Error);
      span.setStatus({ code: SpanStatusCode.ERROR, message: (err as Error).message });
      throw err;
    } finally {
      span.end();
    }
  });
}
