import { createHash, randomBytes, randomInt, timingSafeEqual } from 'crypto';
import type { PrismaClient } from '@prisma/client';
import {
  EmailIdentityProvider as EmailProvider,
  IdentityError,
  IdentityUserInfo,
} from '@harmoniq/core/dist/ports/IdentityProvider';
import { IMailer } from '@harmoniq/core/dist/ports/IMailer';

const TOKEN_TTL_MS = 15 * 60 * 1000;
const MAX_CODE_ATTEMPTS = 5;
/** Per email per TTL window; further requests are silently dropped (no enumeration). */
const MAX_REQUESTS_PER_WINDOW = 5;

const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');
const sameHash = (a: string, b: string) =>
  a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

/**
 * Passwordless email sign-in (product-analysis §5.11): a magic link plus a 6-digit code,
 * stored only as hashes, 15 minutes, single use. The link is bound to the browser that
 * requested it via a nonce cookie (login CSRF); on another device, the code works.
 */
export class EmailIdentityProvider implements EmailProvider {
  readonly kind = 'email';
  readonly id = 'email';
  readonly displayName = 'Email';

  constructor(
    private db: PrismaClient,
    /** Read on every send: the instance's email settings can change at runtime (INST-12). */
    private mailer: () => IMailer | null,
    /** The instance's name (INST-14). */
    private brand: () => string = () => 'Harmoniq'
  ) {}

  async requestLogin({
    email: rawEmail,
    redirectUri,
    nonce,
  }: {
    email: string;
    redirectUri: string;
    nonce: string;
  }): Promise<void> {
    const email = rawEmail.trim().toLowerCase();
    const mailer = this.mailer();
    if (!mailer) throw new IdentityError('provider_unavailable', 'Email sign-in is not available');
    const recent = await this.db.emailLoginToken.count({
      where: { email, createdAt: { gt: new Date(Date.now() - TOKEN_TTL_MS) } },
    });
    if (recent >= MAX_REQUESTS_PER_WINDOW) return;

    const token = randomBytes(32).toString('base64url');
    const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
    await this.db.emailLoginToken.create({
      data: {
        email,
        tokenHash: sha256(token),
        codeHash: sha256(`${email}:${code}`),
        nonceHash: sha256(nonce),
        expiresAt: new Date(Date.now() + TOKEN_TTL_MS),
      },
    });

    const link = new URL(redirectUri);
    link.searchParams.set('token', token);
    const name = this.brand();
    await mailer.send({
      to: email,
      subject: `Your ${name} sign-in code: ${code}`,
      text: [
        `Sign in to ${name}:`,
        '',
        link.toString(),
        '',
        `Or enter this code: ${code}`,
        '',
        'The link and code expire in 15 minutes and work once.',
        'If you did not request this, you can ignore this email.',
      ].join('\n'),
    });
  }

  async verifyLogin(
    params: { token: string; nonce: string } | { email: string; code: string }
  ): Promise<IdentityUserInfo> {
    const now = new Date();
    const invalid = () =>
      new IdentityError('invalid_token', 'This sign-in link or code is invalid or has expired');

    let record;
    if ('token' in params) {
      record = await this.db.emailLoginToken.findUnique({
        where: { tokenHash: sha256(params.token) },
      });
      if (!record || record.usedAt || record.expiresAt <= now) throw invalid();
      // The link only works in the browser that asked for it.
      if (!sameHash(record.nonceHash, sha256(params.nonce))) {
        throw new IdentityError(
          'invalid_token',
          'Open the link in the browser where you requested it, or enter the code instead'
        );
      }
    } else {
      const email = params.email.trim().toLowerCase();
      record = await this.db.emailLoginToken.findFirst({
        where: { email, usedAt: null, expiresAt: { gt: now } },
        orderBy: { createdAt: 'desc' },
      });
      if (!record || record.attempts >= MAX_CODE_ATTEMPTS) throw invalid();
      if (!sameHash(record.codeHash, sha256(`${email}:${params.code.trim()}`))) {
        await this.db.emailLoginToken.update({
          where: { id: record.id },
          data: { attempts: { increment: 1 } },
        });
        throw invalid();
      }
    }

    // Atomic single use: a concurrent second redemption finds nothing to claim.
    const claimed = await this.db.emailLoginToken.updateMany({
      where: { id: record.id, usedAt: null },
      data: { usedAt: now },
    });
    if (claimed.count === 0) throw invalid();

    return { providerUserId: record.email, email: record.email, emailVerified: true };
  }
}
