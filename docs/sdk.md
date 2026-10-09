# Harmoniq SDK Reference

`@harmoniq/client` loads a host app's manifest from the registry and tells the app which URL and integrity hash to use for each remote module. It has no runtime dependencies and never sends credentials — manifests are public, and browsers must not hold API keys.

```bash
pnpm add @harmoniq/client
```

## Core client

```ts
import { HarmoniqClient, EVENTS } from '@harmoniq/client';

const client = new HarmoniqClient({
  registryUrl: 'https://registry.acme.dev',
  workspaceSlug: 'acme',
  hostApp: 'consumer-portal',
  environment: 'production',
  pollIntervalMs: 30_000, // optional: pick up deploys and rollbacks without a reload
});

await client.init(); // safe to call many times; one load, one poll loop

const entry = client.getModuleEntry('checkout');
// { url: 'https://cdn.acme.com/checkout/1.2.3/remoteEntry.js', integrity: 'sha384-…', version: '1.2.3' }
```

| Option             | Default        | Description                                                                                                                              |
| ------------------ | -------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `cdnBaseUrl`       | —              | Read the published copy from your CDN first, the registry second (stable variant only)                                                   |
| `sources`          | registry       | Explicit manifest URLs to try in order (overrides `cdnBaseUrl`)                                                                          |
| `persist`          | `localStorage` | Where the last good manifest is kept across page loads; `false` disables                                                                 |
| `fallbackManifest` | —              | Manifest bundled with the build (`harmoniq manifest pull`), used when nothing is reachable or persisted                                  |
| `pollIntervalMs`   | off            | Re-fetch interval. Uses ETags, so unchanged manifests cost a 304.                                                                        |
| `maxBackoffMs`     | 60000          | Cap for exponential backoff (with jitter) after failed polls                                                                             |
| `timeoutMs`        | 5000           | Per-request timeout                                                                                                                      |
| `fetch`            | global         | Custom fetch implementation                                                                                                              |
| `userId`           | —              | Opaque user id for canary assignment, sent as `X-Harmoniq-User-Id` to the registry only. While set, the registry is asked before the CDN |
| `reportHealth`     | off            | `true` or `{ sampleRate, flushIntervalMs }`: send module load outcomes to the registry (batched, `sendBeacon`)                           |
| `anonymousCanary`  | `false`        | Without `userId`, give each browser a random id kept in `persist` storage so anonymous visitors take part in canaries                    |

| Method                                                                                    | Returns                                                                                       |
| ----------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `init()`                                                                                  | Loads the manifest and starts polling. Rejects if the first load fails; call again to retry.  |
| `getManifest()`                                                                           | The full manifest (`schemaVersion: 2`) or `null`                                              |
| `getModuleEntry(name)`                                                                    | `{ url, integrity, version }` or `null`                                                       |
| `getModule(name)`                                                                         | The full module entry, including `dependencies`, `exposes`, `metadata`                        |
| `getScriptTag(name)`                                                                      | `<script type="module" … integrity crossorigin>` with escaped attributes                      |
| `getVariant()` / `getCohortId()`                                                          | Canary assignment: `stable` or `canary`, and the opaque cohort id (safe to send to analytics) |
| `reportModuleLoad(name, { success, loadMs?, error? })` / `reportModuleError(name, error)` | Record a load outcome (no-op unless `reportHealth`)                                           |
| `flushHealth()`                                                                           | Send queued reports now (also on page hide and `destroy()`)                                   |
| `setUserId(id \| null)`                                                                   | Change the user (e.g. after sign-in) and re-fetch so their variant applies immediately        |
| `getError()`                                                                              | Error from the last failed fetch, or `null`                                                   |
| `on(event, fn)`                                                                           | Subscribe; returns an unsubscribe function                                                    |
| `destroy()`                                                                               | Stop polling and remove listeners                                                             |

**Events** (`EVENTS.*`): `manifestUpdate` (only when the content changes), `variantAssigned` (first assignment and changes), `manifestStale` (serving a persisted or bundled copy), `error` (each failed fetch).

**Failures**: sources are tried in order. If all fail, the last manifest stays in use (stale beats broken) and polling backs off. On a cold start with every source down, `init()` uses the persisted copy, then `fallbackManifest`, and emits `manifestStale`; `getSource()` reports `network`, `persisted` or `fallback`. `init()` rejects only when none of these exist.

### Canary releases

```ts
const client = new HarmoniqClient({ ...options, cdnBaseUrl, userId: currentUser?.id });
client.on(EVENTS.variantAssigned, ({ variant, cohortId }) =>
  analytics.track('variant', { variant, cohortId })
);
// later, after sign-in:
await client.setUserId(user.id);
```

The registry decides the variant per user and module; the CDN copy is always stable, so with a user id the registry is asked first and the CDN is the fallback. Use an opaque id: the registry never echoes it, only `cohortId`.

### Module health

With `reportHealth: true` the client batches load outcomes and sends them to the registry, which shows success rate and load times per module, split by stable and canary, in the dashboard. `@harmoniq/mf-plugin` reports every remote's first load automatically; other loaders call `reportModuleLoad` / `reportModuleError`. Reports carry the module version from the manifest; overridden modules are never reported. Use `sampleRate` on high-traffic hosts.

### Surviving a registry outage

```ts
import fallbackManifest from './harmoniq-fallback.json'; // harmoniq manifest pull --env production --out …

new HarmoniqClient({
  registryUrl: 'https://registry.acme.dev',
  cdnBaseUrl: 'https://cdn.acme.dev', // in front of the bucket the registry publishes to
  fallbackManifest,
  workspaceSlug: 'acme',
  hostApp: 'consumer-portal',
  environment: 'production',
});
```

## React

```tsx
import { HarmoniqProvider, useRemoteModule } from '@harmoniq/client/react';

<HarmoniqProvider options={options} fallback={<Spinner />}>
  <App />
</HarmoniqProvider>;

function CheckoutSlot() {
  const { url, integrity, loading, error } = useRemoteModule('checkout');
  // load `url` with your module loader; re-renders when a new version is deployed
}
```

- Renders during SSR (the provider never returns `null`); loading starts in the browser.
- `fallback` is shown until the first manifest loads; without it, children render immediately and hooks report `loading`.
- Pass `client` instead of `options` to share a client with non-React code.
- Also exported: `useManifest()`, `useHarmoniqError()`, `useHarmoniqClient()`.

## Vue

```ts
import { createHarmoniq, useHarmoniq } from '@harmoniq/client/vue';

app.use(createHarmoniq(options));

// in setup()
const { url, integrity, version, loading, error } = useHarmoniq('checkout');
```

## Angular

```ts
import { HARMONIQ_OPTIONS, HarmoniqService } from '@harmoniq/client/angular';

providers: [{ provide: HARMONIQ_OPTIONS, useValue: options }];

constructor(harmoniq: HarmoniqService) {
  harmoniq.getModule('checkout').subscribe(({ url, integrity, loading, error }) => { … });
}
```

`HarmoniqService.manifest$` emits every new manifest.

## Local overrides and preview links

Point a deployed host at a module running on your machine — no host rebuild:

```ts
new HarmoniqClient({ ...options, allowOverrides: process.env.NODE_ENV !== 'production' });
```

```
https://staging.acme.com/?harmoniq-override=checkout@http://localhost:5001/remoteEntry.js
```

Several: comma-separate them. Overrides can also live in `localStorage['harmoniq:overrides']` (`{"checkout":"http://localhost:5001/remoteEntry.js"}`) or the `overrides` option. Overridden modules skip integrity checks, emit `overrideActive` and log a warning; only `http(s)` URLs are accepted. Keep `allowOverrides` off in production.

For preview environments, `environmentFromQuery: 'harmoniq-env'` lets `?harmoniq-env=pr-123` select the environment (non-production hosts only).

## Module Federation 2.0

`@harmoniq/mf-plugin` resolves remotes from the manifest inside the MF runtime, so components keep using `loadRemote('checkout/Page')` (or static `import`s) unchanged.

```ts
import { init, loadRemote } from '@module-federation/enhanced/runtime';
import { HarmoniqClient } from '@harmoniq/client';
import { harmoniqPlugin } from '@harmoniq/mf-plugin';

const client = new HarmoniqClient({ ...options, pollIntervalMs: 30_000 });
init({ name: 'host', remotes: [], plugins: [harmoniqPlugin(client)] });

const { CheckoutPage } = await loadRemote('checkout/CheckoutPage');
```

- Each request is resolved against the current manifest; remotes missing from your static config are added.
- New deploys and rollbacks are hot-swapped (`registerRemotes(…, { force: true })`); the next `loadRemote` gets the new version.
- Remote entry scripts get `integrity` and `crossorigin` from the manifest (SRI-04).
- Options: `remoteNames` (MF remote name → Harmoniq module name), `strict` (refuse remotes not in the manifest).
- Reports each remote's first load (time or error) to `client.reportModuleLoad` when the client has `reportHealth` on (`reportLoads: false` to disable).
- `harmoniqRemotes(client)` returns `{ name, entry }[]` for `init({ remotes })` when you prefer static registration.

## Planned

| Feature                                         | Milestone |
| ----------------------------------------------- | --------- |
| Load-health reporting and error-tracker tagging | M3.2–M3.3 |
