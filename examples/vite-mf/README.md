# Vite + Module Federation 2.0 with Harmoniq

A host and two remotes (`greeting`, `cart`) built with Vite and [`@module-federation/vite`](https://module-federation.io/guide/basic/vite.html):

- **Remotes** register every build with Harmoniq through [`@harmoniq/build-plugin`](../../packages/build-plugin) (SRI hash, `exposes` from `mf-manifest.json`). Each version is built into `dist/<version>` and served from its own URL, so older versions stay available for rollback.
- **The host** is built once. It declares its remotes without URLs; [`@harmoniq/mf-plugin`](../../packages/mf-plugin) resolves them from the Harmoniq manifest at load time and swaps them in place when a deploy or rollback lands.
- **`serve.mjs`** stands in for a CDN: it serves the host, the remote builds and the registry's published manifests (keeping the last copy if the registry is unreachable).

```
host/      Vite app: HarmoniqClient + MF runtime (createInstance) + harmoniqPlugin
greeting/  remote exposing ./widget
cart/      remote exposing ./widget
serve.mjs  CDN stand-in on http://localhost:5080
e2e.mjs    the end-to-end test below
```

## Run the end-to-end test

Needs a registry on `http://localhost:4000` with `HARMONIQ_DEV_LOGIN=1` and the default local storage, the workspace built (`pnpm build`) and Google Chrome (or `CHROME_PATH`).

```bash
pnpm --filter @harmoniq-example/vite-mf e2e
```

It creates a throwaway workspace and checks:

| Check                                | How                                                                                   |
| ------------------------------------ | ------------------------------------------------------------------------------------- |
| Build plugin deploys both remotes    | `vite build` with `HARMONIQ_DEPLOY=1`; manifest lists both with `exposes`             |
| Host loads remotes from the CDN copy | Headless Chrome; manifest source `network` via the CDN                                |
| Deploy reaches an open page          | Build `greeting` 2.0.0; the page re-mounts it without reloading                       |
| Rollback reaches an open page        | `harmoniq rollback`; back to 1.0.0 without reloading                                  |
| Registry down                        | Registry URL unreachable, CDN origin cut off; still boots from the CDN's copy         |
| Registry and CDN down                | Both unreachable; boots from the copy persisted in `localStorage`                     |
| First visit with both down           | Fresh browser profile; boots from `fallback-manifest.json` (`harmoniq manifest pull`) |
| Local override                       | `?harmoniq-override=greeting@<url>` loads an undeployed build of one remote           |

CI runs it in the `Build & Test` job.

## Try it by hand

```bash
node serve.mjs &                                    # CDN on :5080
export HARMONIQ_REGISTRY_URL=http://localhost:4000 HARMONIQ_WORKSPACE=<slug> HARMONIQ_API_KEY=<key>
(cd greeting && VERSION=1.0.0 HARMONIQ_DEPLOY=1 pnpm build)
(cd cart && VERSION=1.0.0 HARMONIQ_DEPLOY=1 pnpm build)
(cd host && pnpm build)
open "http://localhost:5080/?workspace=<slug>&cdn=http://localhost:5080"
```

Create the workspace, the `greeting` and `cart` modules and the API key in the dashboard first. Then deploy `greeting` 2.0.0 the same way and watch the open page update.

## Notes

- `@module-federation/vite` emits ES module entries, so the host declares `type: 'module'` for each remote. The MF runtime loads those with `import()`, which has no `integrity` attribute: the SRI hash in the manifest is enforced for script-tag entries only.
- Overrides are on unconditionally here because this is a demo. In a real host, enable `allowOverrides` for non-production builds only.
