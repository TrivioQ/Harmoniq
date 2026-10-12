// Copyright The Harmoniq Authors
// SPDX-License-Identifier: Apache-2.0

import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'crypto';

/**
 * AES-256-GCM envelope stored in JSON columns. `v` is the format version; `kid` (INST-26)
 * is the fingerprint of the key that sealed it (absent on values sealed before keyrings).
 */
export interface EncryptedValue {
  v: 1;
  kid?: string;
  iv: string;
  tag: string;
  ct: string;
}

// ─── Keyring (INST-26) ──────────────────────────────────────────────────────

/** A key's id in envelopes: the first 8 hex digits of its sha256. */
export const keyId = (key: Buffer) => createHash('sha256').update(key).digest('hex').slice(0, 8);

export interface Keyring {
  /** New values are sealed with this key. */
  active: Buffer;
  /** Every key that may open a value, by `keyId`, with the operator's label. */
  keys: Map<string, { key: Buffer; label: string }>;
}

// The active key is what the code passes around (`config.encryptionKey`); its keyring is
// found from it, so callers don't change. Without a registered ring the key is alone.
const rings = new WeakMap<Buffer, Keyring>();

export function registerKeyring(ring: Keyring) {
  rings.set(ring.active, ring);
}

export function keyringOf(key: Buffer): Keyring {
  return (
    rings.get(key) ?? { active: key, keys: new Map([[keyId(key), { key, label: 'default' }]]) }
  );
}

export function isEncryptedValue(value: unknown): value is EncryptedValue {
  const v = value as Partial<EncryptedValue> | null;
  return (
    !!v &&
    typeof v === 'object' &&
    v.v === 1 &&
    typeof v.iv === 'string' &&
    typeof v.tag === 'string' &&
    typeof v.ct === 'string'
  );
}

export function encryptJson(value: unknown, key: Buffer): EncryptedValue {
  const active = keyringOf(key).active;
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', active, iv);
  const ct = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
  return {
    v: 1,
    kid: keyId(active),
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    ct: ct.toString('base64'),
  };
}

/** Throws if the value is not an envelope or fails authentication (wrong key, tampering). */
export function decryptJson<T>(value: unknown, key: Buffer): T {
  if (!isEncryptedValue(value)) {
    throw new Error('Value is not encrypted');
  }
  const ring = keyringOf(key);
  const open = (k: Buffer) => {
    const decipher = createDecipheriv('aes-256-gcm', k, Buffer.from(value.iv, 'base64'));
    decipher.setAuthTag(Buffer.from(value.tag, 'base64'));
    const plain = Buffer.concat([
      decipher.update(Buffer.from(value.ct, 'base64')),
      decipher.final(),
    ]);
    return JSON.parse(plain.toString('utf8')) as T;
  };
  if (value.kid) {
    // A value sealed with a key no longer configured fails closed.
    const entry = ring.keys.get(value.kid);
    if (!entry) throw new Error(`No encryption key ${value.kid} is configured`);
    return open(entry.key);
  }
  // Sealed before key ids: GCM authentication tells which key it was.
  let last: unknown;
  for (const { key: k } of [ring.keys.get(keyId(ring.active))!, ...ring.keys.values()]) {
    try {
      return open(k);
    } catch (err) {
      last = err;
    }
  }
  throw last;
}

/** The key id a sealed value (envelope or `sealSecret` string) uses; null for legacy ones. */
export function sealedKeyId(value: unknown): string | null | undefined {
  if (typeof value === 'string') {
    if (!value.startsWith(SEALED_PREFIX)) return undefined;
    return envelopeOf(value).kid ?? null;
  }
  return isEncryptedValue(value) ? (value.kid ?? null) : undefined;
}

/** For display only: reveals at most the last 4 characters of long values. */
export function maskSecret(secret: string): string {
  return secret.length > 8 ? `••••${secret.slice(-4)}` : '••••';
}

const SEALED_PREFIX = 'enc:v1:';

/** Encrypts a secret for a plain string column (e.g. webhook signing secrets). */
export function sealSecret(plain: string, key: Buffer): string {
  return SEALED_PREFIX + Buffer.from(JSON.stringify(encryptJson(plain, key))).toString('base64');
}

/** Reverses sealSecret. Values stored before encryption existed are returned as-is. */
export function openSecret(stored: string, key: Buffer): string {
  if (!stored.startsWith(SEALED_PREFIX)) return stored;
  return decryptJson<string>(envelopeOf(stored), key);
}

function envelopeOf(stored: string): EncryptedValue {
  return JSON.parse(Buffer.from(stored.slice(SEALED_PREFIX.length), 'base64').toString('utf8'));
}

/**
 * INST-26: every sealed value inside `value` (a column's JSON or string) re-sealed with the
 * active key. Returns the new value and how many were re-sealed (0: leave the row alone).
 */
export function resealDeep(value: unknown, key: Buffer): { value: unknown; changed: number } {
  const activeId = keyId(keyringOf(key).active);
  let changed = 0;
  const walk = (v: unknown): unknown => {
    if (typeof v === 'string') {
      const kid = sealedKeyId(v);
      if (kid === undefined || kid === activeId) return v;
      changed++;
      return sealSecret(openSecret(v, key), key);
    }
    if (isEncryptedValue(v)) {
      if (v.kid === activeId) return v;
      changed++;
      return encryptJson(decryptJson(v, key), key);
    }
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') {
      return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]));
    }
    return v;
  };
  const result = walk(value);
  return { value: result, changed };
}

/** Counts sealed values inside `value` by key id (`legacy`: sealed before key ids). */
export function countSealed(value: unknown, into: Map<string, number>) {
  const walk = (v: unknown) => {
    const kid = sealedKeyId(v);
    if (kid !== undefined) {
      into.set(kid ?? 'legacy', (into.get(kid ?? 'legacy') ?? 0) + 1);
      return;
    }
    if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === 'object') Object.values(v).forEach(walk);
  };
  walk(value);
  return into;
}
