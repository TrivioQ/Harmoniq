import nodemailer, { Transporter } from 'nodemailer';
import type SMTPTransport from 'nodemailer/lib/smtp-transport';
import { IMailer, MailMessage } from '@harmoniq/core/dist/ports/IMailer';

/**
 * SMTP via a connection URL (e.g. smtps://user:pass@smtp.example.com:465) or transport
 * options (INST-12 settings).
 */
export class SmtpMailer implements IMailer {
  private transport: Transporter;

  constructor(
    smtp: string | SMTPTransport.Options,
    private from: string
  ) {
    this.transport = nodemailer.createTransport(smtp);
  }

  async send(message: MailMessage): Promise<void> {
    await this.transport.sendMail({ from: this.from, ...message });
  }
}
