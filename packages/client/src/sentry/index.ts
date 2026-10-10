// Copyright The Harmoniq Authors
// SPDX-License-Identifier: Apache-2.0

import { EVENTS, HarmoniqClient } from '../index';

/** The part of `@sentry/browser` (or any Sentry SDK) this uses; pass `Sentry` itself. */
export interface SentryLike {
  setTags(tags: Record<string, string>): void;
  setContext?(name: string, context: Record<string, unknown> | null): void;
}

/**
 * Keeps Sentry's tags in sync with the manifest: every error carries the variant, cohort
 * and the version of each module (`mf.<name>`), so a spike can be traced to a deploy or
 * a canary. Returns a function that stops syncing.
 *
 *   import * as Sentry from '@sentry/browser';
 *   import { harmoniqSentry } from '@harmoniq/client/sentry';
 *   harmoniqSentry(client, Sentry);
 */
export function harmoniqSentry(client: HarmoniqClient, sentry: SentryLike): () => void {
  let previous: string[] = [];
  const apply = () => {
    const tags = client.getTelemetryTags();
    // Modules that left the manifest: blank their tag rather than keep a stale version.
    for (const key of previous) if (!(key in tags)) tags[key] = '';
    previous = Object.keys(tags);
    sentry.setTags(tags);
    const manifest = client.getManifest();
    sentry.setContext?.(
      'harmoniq',
      manifest && {
        etag: manifest.etag,
        generatedAt: manifest.generatedAt,
        source: client.getSource(),
        overrides: client.getOverrides(),
        modules: Object.fromEntries(manifest.modules.map((m) => [m.name, m.version])),
      }
    );
  };
  apply();
  const off = [
    client.on(EVENTS.manifestUpdate, apply),
    client.on(EVENTS.variantAssigned, apply),
    client.on(EVENTS.manifestStale, apply),
  ];
  return () => off.forEach((fn) => fn());
}
