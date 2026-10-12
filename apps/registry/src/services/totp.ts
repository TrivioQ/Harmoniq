// Copyright The Harmoniq Authors
// SPDX-License-Identifier: Apache-2.0

import { createHash, createHmac, randomBytes, timingSafeEqual } from 'crypto';

/**
 * SES-03: TOTP (RFC 6238: HMAC-SHA1, 30-second steps, 6 digits), as authenticator apps
 * expect, and single-use recovery codes.
 */

const STEP_SECONDS = 30;
const DIGITS = 6;
/** Codes of the step before and after are accepted (clock drift). */
const WINDOW = 1;
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Encode(bytes: Buffer) {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(text: string) {
  const clean = text.replace(/=+$/, '').replace(/\s+/g, '').toUpperCase();
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const char of clean) {
    const index = ALPHABET.indexOf(char);
    if (index < 0) throw new Error('Invalid base32');
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** A new secret (160 bits, as RFC 4226 recommends), base32. */
export const newTotpSecret = () => base32Encode(randomBytes(20));

export const timeStep = (now = Date.now()) => Math.floor(now / 1000 / STEP_SECONDS);

/** The code for a time step (RFC 4226 dynamic truncation). */
export function totpCode(secret: string, step: number) {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const hmac = createHmac('sha1', base32Decode(secret)).update(counter).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const binary = hmac.readUInt32BE(offset) & 0x7fffffff;
  return String(binary % 10 ** DIGITS).padStart(DIGITS, '0');
}

/**
 * The time step a code matches, within the window and after `lastStep` (a used code can't
 * be replayed); null when it doesn't match.
 */
export function verifyTotp(
  secret: string,
  code: string,
  opts: { lastStep?: number | null; now?: number } = {}
): number | null {
  if (!/^\d{6}$/.test(code)) return null;
  const current = timeStep(opts.now);
  for (let delta = -WINDOW; delta <= WINDOW; delta++) {
    const step = current + delta;
    if (opts.lastStep !== null && opts.lastStep !== undefined && step <= opts.lastStep) continue;
    const expected = Buffer.from(totpCode(secret, step));
    if (timingSafeEqual(expected, Buffer.from(code))) return step;
  }
  return null;
}

/** For authenticator apps (and the QR code the dashboard draws). */
export function otpauthUrl(secret: string, account: string, issuer: string) {
  const label = encodeURIComponent(`${issuer}:${account}`);
  const params = new URLSearchParams({
    secret,
    issuer,
    algorithm: 'SHA1',
    digits: String(DIGITS),
    period: String(STEP_SECONDS),
  });
  return `otpauth://totp/${label}?${params}`;
}

// ─── Recovery codes ─────────────────────────────────────────────────────────

export const RECOVERY_CODES = 10;

const normalizeRecovery = (code: string) => code.replace(/[\s-]/g, '').toLowerCase();
export const hashRecoveryCode = (code: string) =>
  createHash('sha256').update(normalizeRecovery(code)).digest('hex');

/** `xxxxx-xxxxx` codes (50 bits each), shown once; only their hashes are kept. */
export function newRecoveryCodes() {
  return Array.from({ length: RECOVERY_CODES }, () => {
    const raw = base32Encode(randomBytes(7)).slice(0, 10).toLowerCase();
    return `${raw.slice(0, 5)}-${raw.slice(5)}`;
  });
}

/** The remaining hashes once `code` is used, or null when it isn't one of them. */
export function useRecoveryCode(hashes: string[], code: string) {
  const hash = hashRecoveryCode(code);
  const index = hashes.indexOf(hash);
  return index < 0 ? null : hashes.filter((_, i) => i !== index);
}
