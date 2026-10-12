// Copyright The Harmoniq Authors
// SPDX-License-Identifier: Apache-2.0

import type { PrismaClient } from '@prisma/client';
import type { IMailer, MailMessage } from '@harmoniq/core/dist/ports/IMailer';

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/**
 * INST-38: every email goes through here. It applies the template's subject and intro
 * overrides and records the delivery (recipient, template, result; never the body).
 */
export class RecordingMailer implements IMailer {
  constructor(
    readonly inner: IMailer,
    private deps: {
      systemDb: PrismaClient;
      override: (template: string) => { subject?: string; intro?: string };
    }
  ) {}

  async send(message: MailMessage): Promise<void> {
    const template = message.template ?? 'other';
    const { subject, intro } = this.deps.override(template);
    const out: MailMessage = {
      ...message,
      subject: subject ?? message.subject,
      text: intro ? `${intro}\n\n${message.text}` : message.text,
      ...(message.html && {
        html: intro ? `<p>${escapeHtml(intro)}</p>\n${message.html}` : message.html,
      }),
    };
    try {
      await this.inner.send(out);
      await this.record(message.to, template, 'sent');
    } catch (err) {
      await this.record(message.to, template, 'failed', (err as Error).message);
      throw err;
    }
  }

  private async record(to: string, template: string, status: string, error?: string) {
    await this.deps.systemDb.emailDelivery
      .create({ data: { to, template, status, error: error?.slice(0, 1000) } })
      .catch(() => undefined); // the log never stops an email
  }
}
