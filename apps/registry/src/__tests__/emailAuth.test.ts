// Copyright The Harmoniq Authors
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomBytes, randomUUID } from 'crypto';
import { FastifyInstance } from 'fastify';
import { buildApp } from '../app';
import { ConsoleMailer } from '../adapters/mail/ConsoleMailer';
import { RecordingMailer } from '../services/emailLog';

const WEB = 'http://localhost:3000';

describe('Email sign-in', () => {
  let app: FastifyInstance;
  let mailer: ConsoleMailer;
  const emails: string[] = [];

  const newEmail = () => {
    const email = `mail-${randomUUID()}@example.com`;
    emails.push(email);
    return email;
  };
  const nonce = () => randomBytes(16).toString('base64url');

  const request = (email: string, n = nonce()) =>
    app.inject({
      method: 'POST',
      url: '/api/auth/email/request',
      payload: { email, nonce: n, redirectUri: `${WEB}/auth/verify` },
    });
  const verify = (payload: object) =>
    app.inject({ method: 'POST', url: '/api/auth/email/verify', payload });

  /** The token and code from the most recent mail to `email`. */
  const lastMail = (email: string) => {
    const message = [...mailer.sent].reverse().find((m) => m.to === email)!;
    return {
      token: new URL(message.text.match(/https?:\/\/\S+/)![0]).searchParams.get('token')!,
      code: message.text.match(/code: (\d{6})/)![1],
    };
  };

  beforeAll(async () => {
    process.env.WEB_ORIGIN = WEB;
    app = await buildApp();
    await app.ready();
    mailer = (app.container.mailer as RecordingMailer).inner as ConsoleMailer;
  });

  afterAll(async () => {
    await app.container.systemDb.emailLoginToken.deleteMany({ where: { email: { in: emails } } });
    await app.container.systemDb.user.deleteMany({ where: { email: { in: emails } } });
    await app.close();
  });

  it('is offered as a provider', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/auth/providers' });
    expect(res.json().providers).toContainEqual(
      expect.objectContaining({ id: 'email', kind: 'email' })
    );
  });

  it('signs in with the link in the requesting browser, once', async () => {
    const email = newEmail();
    const n = nonce();
    expect((await request(email, n)).statusCode).toBe(202);
    const { token } = lastMail(email);

    const res = await verify({ token, nonce: n });
    expect(res.statusCode).toBe(200);
    expect(res.json().user.email).toBe(email);

    expect((await verify({ token, nonce: n })).statusCode).toBe(401); // single use
  });

  it('refuses the link in another browser but accepts the code there', async () => {
    const email = newEmail();
    await request(email);
    const { token, code } = lastMail(email);

    const elsewhere = await verify({ token, nonce: nonce() });
    expect(elsewhere.statusCode).toBe(401);
    expect(elsewhere.json().error.message).toContain('browser where you requested it');

    expect((await verify({ email, code })).statusCode).toBe(200);
  });

  it('locks the code after five wrong attempts', async () => {
    const email = newEmail();
    await request(email);
    const { code } = lastMail(email);
    const wrong = code === '000000' ? '111111' : '000000';
    for (let i = 0; i < 5; i++) expect((await verify({ email, code: wrong })).statusCode).toBe(401);
    expect((await verify({ email, code })).statusCode).toBe(401);
  });

  it('answers the same for unknown addresses and silently caps requests per email', async () => {
    const email = newEmail();
    for (let i = 0; i < 7; i++) expect((await request(email)).statusCode).toBe(202);
    expect(mailer.sent.filter((m) => m.to === email)).toHaveLength(5);
  });

  it('stores only hashes', async () => {
    const email = newEmail();
    await request(email);
    const { token, code } = lastMail(email);
    const row = await app.container.systemDb.emailLoginToken.findFirstOrThrow({ where: { email } });
    expect(JSON.stringify(row)).not.toContain(token);
    expect(row.codeHash).not.toContain(code);
  });

  it('only links to the dashboard origin', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/email/request',
      payload: { email: newEmail(), nonce: nonce(), redirectUri: 'https://evil.example/verify' },
    });
    expect(res.statusCode).toBe(400);
  });
});
