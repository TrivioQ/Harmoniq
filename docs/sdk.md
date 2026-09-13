# Harmoniq SDK Reference

The `@harmoniq/client` SDK provides a type-safe wrapper for fetching module manifests and verifying integrations from the Harmoniq Registry.

## Installation

```bash
npm install @harmoniq/client
# or
yarn add @harmoniq/client
# or
pnpm add @harmoniq/client
```

## Initialization

You can instantiate the `HarmoniqClient` by providing the registry endpoint and your workspace configurations.

```typescript
import { HarmoniqClient } from '@harmoniq/client';

const client = new HarmoniqClient({
  registryUrl: 'https://registry.your-harmoniq.com',
  workspace: 'acme-corp',
  hostApp: 'web-dashboard',
  environment: 'production'
});
```

## Fetching a Manifest

The primary responsibility of the SDK is to resolve the latest active deployment for a given module.

```typescript
const manifest = await client.getManifest('auth-module');
console.log(manifest.url); // e.g. https://cdn.acme.com/auth/remoteEntry.js
```

### Pre-fetching and Hydration

To minimize latency during runtime, you can configure the client to prefetch all known manifests on initialization:

```typescript
const client = new HarmoniqClient({
  // ... config
  prefetchModules: ['auth-module', 'nav-module']
});

await client.prefetch();
```

## Fallbacks

If the registry is unreachable or offline, the SDK supports graceful fallbacks if you configure default URLs:

```typescript
const client = new HarmoniqClient({
  // ... config
  fallbacks: {
    'auth-module': 'https://fallback.cdn.com/auth/remoteEntry.js'
  }
});
```
