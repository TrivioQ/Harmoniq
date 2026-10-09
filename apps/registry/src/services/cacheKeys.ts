import { ICache } from '@harmoniq/core/dist/ports/ICache';

// Every cache key lives here so invalidation can never miss a variant. Slugs are
// validated as [a-z0-9-] on creation, so they are safe inside glob patterns.

export const manifestKey = (ws: string, host: string, env: string, variant = 'stable') =>
  `manifest:${ws}:${host}:${env}:${variant}`;

/**
 * Last-known-good manifest (MAN-06), served when the database is unreachable. Kept
 * outside the `manifest:` namespace so invalidation never removes it; it is overwritten
 * with every successful build instead.
 */
export const lastKnownGoodKey = (ws: string, host: string, env: string) =>
  `manifest-lkg:${ws}:${host}:${env}`;

export const importMapKey = (ws: string, host: string, env: string) =>
  `importmap:${ws}:${host}:${env}`;

/** Drops every cached variant of one environment's manifest and import map. */
export async function invalidateManifest(cache: ICache, ws: string, host: string, env: string) {
  await Promise.all([
    cache.invalidatePattern(manifestKey(ws, host, env, '*')),
    cache.del(importMapKey(ws, host, env)),
  ]);
}
