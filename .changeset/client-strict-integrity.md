---
'@harmoniq/client': minor
---

`loadModule()` with `loaderMode: 'amd'` now warns once per module that RequireJS can't enforce its integrity hash, and the new `strictIntegrity` option refuses such loads instead. Published manifests no longer include `metadata.deployedBy`.
