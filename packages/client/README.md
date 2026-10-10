# @harmoniq/client

Browser SDK for [Harmoniq](https://github.com/TrivioQ/Harmoniq), the open-source micro frontend control plane.

Instead of hard-coding the URL of every remote module into your host build, the host asks Harmoniq at runtime which version of each module to load. Deploys, rollbacks, canaries and the kill switch take effect without rebuilding or redeploying the host.

- **Zero runtime dependencies.** Works in any framework, and has bindings for React, Vue and Angular.
- **Resilient.** Falls back from the CDN to the registry, then to the last manifest persisted in the browser, then to a manifest bundled with your build. A registry outage never stops the app from booting.
- **Safe.** Every module URL comes with a Subresource Integrity (SRI) hash that the loader enforces.
- **Progressive delivery.** Sticky canary assignment per user, targeting by attributes, and health reporting that feeds alerts and staged rollouts.
- **Live updates.** Optional polling (with ETags and exponential backoff) hot-swaps a module when a new version is deployed.

## Install

```bash
npm install @harmoniq/client
# or: pnpm add @harmoniq/client / yarn add @harmoniq/client
```

The `react`, `vue` and `angular` entry points have optional peer dependencies on those frameworks. The core entry point needs none.

## Quick start

```ts
import { HarmoniqClient, EVENTS } from '@harmoniq/client';

const client = new HarmoniqClient({
  registryUrl: 'https://registry.acme.dev',
  workspaceSlug: 'acme-corp',
  hostApp: 'consumer-portal',
  environment: 'production',
  pollIntervalMs: 30_000, // pick up deploys and rollbacks without a page reload
  userId: currentUser?.id, // opaque id, used for sticky canary assignment
  reportHealth: true, // feed module health, alerts and staged rollouts
});

await client.init();

// ESM by default; 'systemjs', 'amd' or a custom loader also work.
const { mount } = await client.loadModule<{ mount: (el: Element) => void }>('checkout');
mount(document.getElementById('checkout')!);

client.on(EVENTS.manifestUpdate, () => console.log('a new version was deployed'));
client.on(EVENTS.variantAssigned, ({ variant, cohortId }) =>
  analytics.track('variant', { variant, cohortId })
);
```

`init()` is idempotent and starts the poll loop when `pollIntervalMs` is set. Call `client.destroy()` when you are done (it stops polling and flushes pending health reports).

## Options

| Option                 | Type                                           | Description                                                                                                                        |
| ---------------------- | ---------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `registryUrl`          | `string`                                       | Base URL of the Harmoniq registry. **Required.**                                                                                   |
| `workspaceSlug`        | `string`                                       | Workspace the host app belongs to. **Required.**                                                                                   |
| `hostApp`              | `string`                                       | Host app slug. **Required.**                                                                                                       |
| `environment`          | `string`                                       | Environment to read, e.g. `production`. **Required.**                                                                              |
| `cdnBaseUrl`           | `string`                                       | CDN in front of the published manifests. Tried first, with the registry as a fallback (the CDN copy is always the stable variant). |
| `sources`              | `string[]`                                     | Full control over the manifest URLs to try, in order. Overrides `cdnBaseUrl`.                                                      |
| `userId`               | `string`                                       | Opaque user id for sticky canary assignment. Sent to the registry only.                                                            |
| `anonymousCanary`      | `boolean`                                      | Without `userId`, give visitors a random id kept in storage so they take part in canaries.                                         |
| `context`              | `Record<string, string \| number \| boolean>`  | Attributes for canary targeting, e.g. `{ plan: 'beta' }`. Keep it under 2 KB and free of secrets.                                  |
| `fallbackManifest`     | `Manifest`                                     | Manifest bundled with the host build (see `harmoniq manifest pull`), used when nothing else is available.                          |
| `allowOverrides`       | `boolean`                                      | Let developers point modules at local builds. Enable outside production only.                                                      |
| `overrides`            | `Record<string, string>`                       | Module name to URL overrides (also read from `?harmoniq-override=name@url` and `localStorage`).                                    |
| `environmentFromQuery` | `string`                                       | Query parameter that selects the environment, e.g. `harmoniq-env` for preview links. Non-production hosts only.                    |
| `persist`              | `ManifestStore \| false`                       | Where to keep the last good manifest. Defaults to `localStorage`; `false` disables it.                                             |
| `pollIntervalMs`       | `number`                                       | Re-fetch the manifest on this interval. Unchanged manifests are cheap (ETag).                                                      |
| `maxBackoffMs`         | `number`                                       | Upper bound for exponential backoff after failed polls. Default 60 s.                                                              |
| `timeoutMs`            | `number`                                       | Per-request timeout, per source. Default 5 s.                                                                                      |
| `fetch`                | `typeof fetch`                                 | Custom fetch, for tests or SSR polyfills.                                                                                          |
| `reportHealth`         | `boolean \| { sampleRate?, flushIntervalMs? }` | Report module load outcomes for health dashboards, canary comparisons and alerts. Off by default.                                  |
| `loaderMode`           | `'esm' \| 'systemjs' \| 'amd' \| function`     | How `loadModule()` loads a module. Default `esm`.                                                                                  |
| `strictIntegrity`      | `boolean`                                      | Refuse to load a module whose integrity hash the loader cannot enforce (the `amd` loader), instead of warning.                     |

## API

| Method                                                              | Description                                                                                      |
| ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `init()`                                                            | Load the manifest and start polling. Rejects only if no source and no offline copy is available. |
| `destroy()`                                                         | Stop polling, drop listeners, flush health reports. The last manifest stays readable.            |
| `loadModule<T>(name)`                                               | Load a module with the configured loader. Rejects for unknown or disabled modules.               |
| `getManifest()`                                                     | The current manifest, or `null`.                                                                 |
| `getModule(name)` / `getModuleUrl(name)`                            | Manifest entry or URL for one module.                                                            |
| `getModuleEntry(name)`                                              | `{ url, integrity, version }`, or `null` when missing or disabled.                               |
| `isModuleDisabled(name)`                                            | `{ reason }` when the kill switch is on for this module, else `null`.                            |
| `getScriptTag(name)`                                                | A ready-to-inject `<script type="module">` tag with `integrity` and `crossorigin` set.           |
| `getVariant()` / `getCohortId()`                                    | `'stable'` or `'canary'`, and the (hashed) cohort this user belongs to.                          |
| `getSource()`                                                       | `'network'`, `'persisted'` or `'fallback'`. Anything but `network` may be stale.                 |
| `getError()`                                                        | The error from the most recent failed fetch.                                                     |
| `setUserId(id)` / `setContext(ctx)`                                 | Change the canary identity or targeting attributes (e.g. after sign-in) and re-fetch.            |
| `reportModuleLoad(name, report)` / `reportModuleError(name, error)` | Record a load outcome (no-op unless `reportHealth` is on).                                       |
| `flushHealth()`                                                     | Send queued health reports now. Called automatically.                                            |
| `getTelemetryTags()`                                                | Variant, cohort and per-module versions as dotted tags for error trackers and traces.            |
| `on(event, fn)` / `off(event, fn)`                                  | Subscribe to events. `on` returns the unsubscribe function.                                      |

### Events

Event names are exported as `EVENTS`.

| Event                    | Payload                   | Fired when                                         |
| ------------------------ | ------------------------- | -------------------------------------------------- |
| `EVENTS.manifestUpdate`  | `Manifest`                | A manifest with a new ETag was applied.            |
| `EVENTS.variantAssigned` | `{ variant, cohortId }`   | The user's variant was assigned or changed.        |
| `EVENTS.manifestStale`   | `{ source, generatedAt }` | The manifest in use did not come from the network. |
| `EVENTS.moduleDisabled`  | `{ name, reason }`        | A module was switched off by the kill switch.      |
| `EVENTS.overrideActive`  | `Record<string, string>`  | Modules are served from developer overrides.       |
| `EVENTS.error`           | `Error`                   | A manifest fetch failed on every source.           |

## Framework bindings

### React

```tsx
import { HarmoniqProvider, useRemoteModule } from '@harmoniq/client/react';

const options = {
  registryUrl: 'https://registry.acme.dev',
  workspaceSlug: 'acme-corp',
  hostApp: 'consumer-portal',
  environment: 'production',
};

export function Root() {
  return (
    <HarmoniqProvider options={options} fallback={<Spinner />}>
      <App />
    </HarmoniqProvider>
  );
}

function CheckoutSlot() {
  const { url, integrity, loading, error, disabled, disabledReason } = useRemoteModule('checkout');
  if (loading) return <Spinner />;
  if (disabled) return <Fallback reason={disabledReason} />;
  if (error) return <ErrorState error={error} />;
  // load `url` with your module loader; this re-renders when a new version lands
}
```

Exports: `HarmoniqProvider`, `useHarmoniqClient`, `useManifest`, `useHarmoniqError`, `useRemoteModule`. The provider also accepts an existing `client` instead of `options`, and renders children (never `null`) during SSR.

### Vue

```ts
import { createApp } from 'vue';
import { createHarmoniq, useHarmoniq } from '@harmoniq/client/vue';

createApp(App)
  .use(createHarmoniq({ registryUrl, workspaceSlug, hostApp, environment }))
  .mount('#app');

// in a component's setup():
const { url, version, loading, error, disabled } = useHarmoniq('checkout'); // readonly refs
```

### Angular

```ts
import { HARMONIQ_OPTIONS, HarmoniqService } from '@harmoniq/client/angular';

// app.config.ts
providers: [
  { provide: HARMONIQ_OPTIONS, useValue: { registryUrl, workspaceSlug, hostApp, environment } },
];

// in a component
constructor(private harmoniq: HarmoniqService) {}
checkout$ = this.harmoniq.getModule('checkout'); // Observable<ModuleState>
```

## Observability helpers

Tag every error and RUM event with the variant and the module versions the user was running, so a spike can be traced to a deploy or a canary.

```ts
import * as Sentry from '@sentry/browser';
import { datadogRum } from '@datadog/browser-rum';
import { harmoniqSentry } from '@harmoniq/client/sentry';
import { harmoniqDatadog } from '@harmoniq/client/datadog';

const stopSentry = harmoniqSentry(client, Sentry); // sets tags and a `harmoniq` context
const stopDatadog = harmoniqDatadog(client, datadogRum); // sets a `harmoniq` global context
```

Both return a function that stops syncing. For OpenTelemetry or any other tracker, use `client.getTelemetryTags()`.

## Resilience and canary behaviour

- **Source order.** With `cdnBaseUrl` set, the CDN is tried first and the registry second. Once a `userId` or `context` is set, the registry is asked first, because only it can assign canary variants.
- **Offline copy.** If every source fails, `init()` uses the persisted manifest, then `fallbackManifest`, and emits `manifestStale`. It rejects only when none exists.
- **Credentials.** Manifest requests never carry credentials, so no API key belongs in the browser.
- **Overrides.** Overridden modules have no integrity hash. Enable `allowOverrides` outside production only, e.g. `allowOverrides: process.env.NODE_ENV !== 'production'`.

## Related packages

- [`@harmoniq/mf-plugin`](../mf-plugin): Module Federation 2.0 runtime plugin built on this client.
- [`@harmoniq/cli`](../cli): deploy, promote, roll back and manage canaries from CI or a terminal.
- [`@harmoniq/build-plugin`](../build-plugin): register a remote with Harmoniq from your bundler.

Full SDK reference: [docs/sdk.md](../../docs/sdk.md).

## License

Apache-2.0
