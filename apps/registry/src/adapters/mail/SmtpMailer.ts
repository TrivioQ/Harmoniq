import nodemailer, { Transporter } from 'nodemailer';
import { IMailer, MailMessage } from '@harmoniq/core/dist/ports/IMailer';

/** SMTP via a connection URL, e.g. smtps://user:pass@smtp.example.com:465 */
export class SmtpMailer implements IMailer {
  private transport: Transporter;

  constructor(
    smtpUrl: string,
    private from: string
  ) {
    this.transport = nodemailer.createTransport(smtpUrl);
  }

  async send(message: MailMessage): Promise<void> {
    await this.transport.sendMail({ from: this.from, ...message });
  }
}
