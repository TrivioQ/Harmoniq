// Copyright The Harmoniq Authors
// SPDX-License-Identifier: Apache-2.0

// Server/edge only: never import from client components. Mirrors apps/registry/src/config.ts — the web app and registry must share JWT_SECRET.
const KNOWN_DEFAULT_SECRETS = new Set([
  'changeme',
  'super-secret-jwt-key-change-me',
  'super-secret-key-for-development-only',
]);
const DEV_JWT_SECRET = 'harmoniq-dev-only-jwt-secret-do-not-use-in-production';

let cachedJwtKey: Uint8Array | null = null;

/**
 * Security posture (strict secrets, Secure cookies). HARMONIQ_ENV lets the self-hosted
 * demo run the production Next server with the registry's development settings.
 */
export function isProductionEnv(): boolean {
  return (process.env.HARMONIQ_ENV ?? process.env.NODE_ENV) === 'production';
}

/** Resolved lazily so `next build` does not require runtime secrets. */
export function getJwtKey(): Uint8Array {
  if (cachedJwtKey) return cachedJwtKey;

  let secret = process.env.JWT_SECRET;
  if (isProductionEnv()) {
    if (!secret || KNOWN_DEFAULT_SECRETS.has(secret) || secret.length < 32) {
      throw new Error(
        'JWT_SECRET must be set to a random value of at least 32 characters in production'
      );
    }
  } else {
    secret ||= DEV_JWT_SECRET;
  }

  cachedJwtKey = new TextEncoder().encode(secret);
  return cachedJwtKey;
}

export function getRegistryUrl(): string {
  return process.env.REGISTRY_URL || 'http://localhost:4000';
}

/**
 * Public origin of the dashboard; OAuth and email links are built from it. Read at
 * runtime (APP_URL), unlike NEXT_PUBLIC_* values which Next inlines at build time.
 */
export function getAppUrl(): string {
  return process.env.APP_URL || process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000';
}

/** Registry URL as browsers and CI see it (shown in snippets); may differ from REGISTRY_URL. */
export function getPublicRegistryUrl(): string {
  return process.env.PUBLIC_REGISTRY_URL || getRegistryUrl();
}
