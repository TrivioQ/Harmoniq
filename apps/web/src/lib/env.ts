// Server/edge only: never import from client components. Mirrors apps/registry/src/config.ts — the web app and registry must share JWT_SECRET.
const KNOWN_DEFAULT_SECRETS = new Set([
  'changeme',
  'super-secret-jwt-key-change-me',
  'super-secret-key-for-development-only',
]);
const DEV_JWT_SECRET = 'harmoniq-dev-only-jwt-secret-do-not-use-in-production';

let cachedJwtKey: Uint8Array | null = null;

/** Resolved lazily so `next build` does not require runtime secrets. */
export function getJwtKey(): Uint8Array {
  if (cachedJwtKey) return cachedJwtKey;

  let secret = process.env.JWT_SECRET;
  if (process.env.NODE_ENV === 'production') {
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

/** Public origin of the dashboard; OAuth redirect URIs are built from it. */
export function getAppUrl(): string {
  return process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000';
}
