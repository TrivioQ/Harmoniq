# @harmoniq/client

## 1.1.0

### Minor Changes

- bd44dfd: `loadModule(name)` loads a module with the new `loaderMode` option: native ES modules (default, with a `modulepreload` carrying the integrity hash), SystemJS, AMD or a custom loader. Load times and failures are reported to module health when `reportHealth` is on.
- e423f03: `loadModule()` with `loaderMode: 'amd'` now warns once per module that RequireJS can't enforce its integrity hash, and the new `strictIntegrity` option refuses such loads instead. Published manifests no longer include `metadata.deployedBy`.

### Patch Changes

- 6c6b5a8: Export the `EventMap`, `EventName` and `Listener` types used by `on()` / `off()`, and publish only the build output (no compiled tests). API reference: `pnpm --filter @harmoniq/client docs:api` (TypeDoc).
