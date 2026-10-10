// Copyright The Harmoniq Authors
// SPDX-License-Identifier: Apache-2.0

import { IMailer, MailMessage } from '@harmoniq/core/dist/ports/IMailer';
import { ILogger } from '@harmoniq/core/dist/ports/ILogger';

/**
 * Development/test mailer: logs messages instead of sending them and keeps the most
 * recent ones in memory (tests read sign-in codes from `sent`). Never used in production.
 */
export class ConsoleMailer implements IMailer {
  readonly sent: MailMessage[] = [];

  constructor(private logger: ILogger) {}

  async send(message: MailMessage): Promise<void> {
    this.sent.push(message);
    if (this.sent.length > 50) this.sent.shift();
    this.logger.info(`[mail to ${message.to}] ${message.subject}\n${message.text}`);
  }
}
