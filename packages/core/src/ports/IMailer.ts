// Copyright The Harmoniq Authors
// SPDX-License-Identifier: Apache-2.0

export interface MailMessage {
  to: string;
  subject: string;
  text: string;
  html?: string;
}

/** Outbound email (sign-in links, invitations, approval requests). */
export interface IMailer {
  send(message: MailMessage): Promise<void>;
}
