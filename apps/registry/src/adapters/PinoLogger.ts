import { ILogger } from '@harmoniq/core/dist/ports/ILogger';
import pino from 'pino';

export class PinoLogger implements ILogger {
  private logger: pino.Logger;

  constructor(baseBindings?: Record<string, unknown>, parentLogger?: pino.Logger) {
    if (parentLogger) {
      this.logger = parentLogger.child(baseBindings || {});
    } else {
      const isProduction = process.env.NODE_ENV === 'production';
      this.logger = pino({
        level: process.env.LOG_LEVEL || 'info',
        transport: !isProduction ? {
          target: 'pino-pretty',
          options: { colorize: true }
        } : undefined,
        base: baseBindings || {},
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
    const logObj: any = { ...meta };
    if (error) {
      logObj.err = error;
    }
    this.logger.error(logObj, message);
  }

  child(bindings: Record<string, unknown>): ILogger {
    return new PinoLogger(bindings, this.logger);
  }
}
