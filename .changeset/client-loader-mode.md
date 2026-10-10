---
'@harmoniq/client': minor
---

`loadModule(name)` loads a module with the new `loaderMode` option: native ES modules (default, with a `modulepreload` carrying the integrity hash), SystemJS, AMD or a custom loader. Load times and failures are reported to module health when `reportHealth` is on.
