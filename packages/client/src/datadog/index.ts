// Copyright The Harmoniq Authors
// SPDX-License-Identifier: Apache-2.0

import { EVENTS, HarmoniqClient } from '../index';

/** The part of `@datadog/browser-rum` (`datadogRum`) this uses; v5+ or v4 API. */
export interface DatadogRumLike {
  setGlobalContextProperty?(key: string, value: unknown): void;
  /** Browser SDK v4. */
  addRumGlobalContext?(key: string, value: unknown): void;
}

/**
 * Adds a `harmoniq` attribute to every RUM event: environment, variant, cohort and the
 * version of each module, to compare errors and performance between variants. Returns a
 * function that stops syncing.
 *
 *   import { datadogRum } from '@datadog/browser-rum';
 *   import { harmoniqDatadog } from '@harmoniq/client/datadog';
 *   harmoniqDatadog(client, datadogRum);
 */
export function harmoniqDatadog(client: HarmoniqClient, rum: DatadogRumLike): () => void {
  const set = (rum.setGlobalContextProperty ?? rum.addRumGlobalContext)?.bind(rum);
  if (!set) throw new Error('[harmoniq] Unsupported Datadog RUM SDK: no global context API');
  const apply = () => {
    const manifest = client.getManifest();
    set('harmoniq', {
      environment: client.getEnvironment(),
      variant: client.getVariant(),
      cohort: client.getCohortId(),
      manifest: manifest?.etag,
      source: client.getSource(),
      modules: Object.fromEntries(manifest?.modules.map((m) => [m.name, m.version]) ?? []),
    });
  };
  apply();
  const off = [
    client.on(EVENTS.manifestUpdate, apply),
    client.on(EVENTS.variantAssigned, apply),
    client.on(EVENTS.manifestStale, apply),
  ];
  return () => off.forEach((fn) => fn());
}
