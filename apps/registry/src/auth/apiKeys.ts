// Copyright The Harmoniq Authors
// SPDX-License-Identifier: Apache-2.0

import { randomBytes } from 'crypto';
import argon2 from 'argon2';

const KEY_PREFIX = 'hq_';

/**
 * Raw key format: `hq_<keyId>_<secret>` (KEY-01). The key id lets us look up the record
 * directly; only the argon2id hash of the secret is stored.
 */
export function formatApiKey(keyId: string, secret: string): string {
  return `${KEY_PREFIX}${keyId}_${secret}`;
}

export function parseApiKey(raw: string): { keyId: string; secret: string } | null {
  if (!raw.startsWith(KEY_PREFIX)) return null;
  const rest = raw.slice(KEY_PREFIX.length);
  // Key ids are cuids (no underscores); the secret is base64url and may contain them.
  const sep = rest.indexOf('_');
  if (sep <= 0 || sep === rest.length - 1) return null;
  return { keyId: rest.slice(0, sep), secret: rest.slice(sep + 1) };
}

const ORG_KEY_PREFIX = 'hq_org_';

/** ORG-13: organization keys, `hq_org_<keyId>_<secret>`. */
export function formatOrgApiKey(keyId: string, secret: string): string {
  return `${ORG_KEY_PREFIX}${keyId}_${secret}`;
}

export function parseOrgApiKey(raw: string): { keyId: string; secret: string } | null {
  if (!raw.startsWith(ORG_KEY_PREFIX)) return null;
  return parseApiKey(KEY_PREFIX + raw.slice(ORG_KEY_PREFIX.length));
}

export function isApiKeyFormat(token: string): boolean {
  return token.startsWith(KEY_PREFIX);
}

export async function generateApiKeySecret(): Promise<{ secret: string; keyHash: string }> {
  const secret = randomBytes(32).toString('base64url');
  const keyHash = await argon2.hash(secret, { type: argon2.argon2id });
  return { secret, keyHash };
}

/** Display prefix stored on the record, e.g. `hq_clx1a2b3…`. Never enough to authenticate. */
export function displayPrefix(keyId: string): string {
  return `${KEY_PREFIX}${keyId.slice(0, 8)}`;
}
