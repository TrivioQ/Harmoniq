// Copyright The Harmoniq Authors
// SPDX-License-Identifier: Apache-2.0

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

/**
 * "Not found" for one environment, cached briefly so unknown slugs don't reach the
 * database on every request. Inside the `manifest:` namespace on purpose: every
 * invalidation of the environment (a deploy, a promotion) clears it with the manifest.
 */
export const missingManifestKey = (ws: string, host: string, env: string) =>
  manifestKey(ws, host, env, 'missing');

/**
 * The host app the legacy endpoint (`/api/manifest/:ws/:env`, HST-02) resolves to: the
 * workspace's default, or its only host app. An empty value caches "none".
 */
export const defaultHostKey = (ws: string) => `manifest-default-host:${ws}`;

/** Last-known-good default host app, for the legacy endpoint during an outage (MAN-06). */
export const lastKnownDefaultHostKey = (ws: string) => `manifest-lkg-default-host:${ws}`;

/** After host apps are created, deleted or change which one is the default. */
export async function invalidateDefaultHost(cache: ICache, ws: string) {
  await cache.del(defaultHostKey(ws));
}

export const importMapKey = (ws: string, host: string, env: string) =>
  `importmap:${ws}:${host}:${env}`;

/** Drops every cached variant of one environment's manifest and import map. */
export async function invalidateManifest(cache: ICache, ws: string, host: string, env: string) {
  await Promise.all([
    cache.invalidatePattern(manifestKey(ws, host, env, '*')),
    cache.del(importMapKey(ws, host, env)),
  ]);
}
