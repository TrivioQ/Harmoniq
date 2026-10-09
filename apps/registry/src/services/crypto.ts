import { createCipheriv, createDecipheriv, randomBytes } from 'crypto';

/** AES-256-GCM envelope stored in JSON columns. `v` is the format version. */
export interface EncryptedValue {
  v: 1;
  iv: string;
  tag: string;
  ct: string;
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
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
  return {
    v: 1,
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
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(value.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(value.tag, 'base64'));
  const plain = Buffer.concat([decipher.update(Buffer.from(value.ct, 'base64')), decipher.final()]);
  return JSON.parse(plain.toString('utf8')) as T;
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
  const envelope = JSON.parse(
    Buffer.from(stored.slice(SEALED_PREFIX.length), 'base64').toString('utf8')
  );
  return decryptJson<string>(envelope, key);
}
