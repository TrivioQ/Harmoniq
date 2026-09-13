import { ILogger } from '@harmoniq/core/dist/ports/ILogger';
import pino, { Logger } from 'pino';

export class ConsoleLogger implements ILogger {
  private logger: Logger;

  constructor(logger?: Logger) {
    if (logger) {
      this.logger = logger;
    } else {
      this.logger = pino({
        level: process.env.LOG_LEVEL || 'info',
        transport: process.env.NODE_ENV !== 'production' 
          ? {
              target: 'pino-pretty',
              options: {
                colorize: true,
              },
            }
          : undefined,
      });
    }
  }

  info(message: string, meta?: Record<string, unknown>): void {
    if (meta) {
      this.logger.info(meta, message);
    } else {
      this.logger.info(message);
    }
  }

  warn(message: string, meta?: Record<string, unknown>): void {
    if (meta) {
      this.logger.warn(meta, message);
    } else {
      this.logger.warn(message);
    }
  }

  error(message: string, error?: Error, meta?: Record<string, unknown>): void {
    const errorMeta = error ? { err: error, ...meta } : meta;
    if (errorMeta) {
      this.logger.error(errorMeta, message);
    } else {
      this.logger.error(message);
    }
  }

  child(bindings: Record<string, unknown>): ILogger {
    return new ConsoleLogger(this.logger.child(bindings));
  }
}
