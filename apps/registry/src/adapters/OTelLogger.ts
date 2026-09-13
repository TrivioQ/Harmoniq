import { ILogger } from '@harmoniq/core/dist/ports/ILogger';

// In a real implementation, this would be wired to @opentelemetry/api-logs
// or use a pino transport to export to OTLP.
// For now, it wraps console to satisfy the interface.
export class OTelLogger implements ILogger {
  info(message: string, meta?: Record<string, unknown>): void {
    console.log(JSON.stringify({ level: 'info', message, ...meta }));
  }

  warn(message: string, meta?: Record<string, unknown>): void {
    console.warn(JSON.stringify({ level: 'warn', message, ...meta }));
  }

  error(message: string, error?: Error, meta?: Record<string, unknown>): void {
    console.error(
      JSON.stringify({
        level: 'error',
        message,
        error: error?.message,
        stack: error?.stack,
        ...meta,
      })
    );
  }

  child(_bindings: Record<string, unknown>): ILogger {
    // A proper implementation would retain bindings
    return new OTelLogger();
  }
}
