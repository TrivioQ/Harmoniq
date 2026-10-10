# Example: import maps without a bundler

A static HTML host (`host/index.html`) loads a remote module (`@example/greeting`) through Harmoniq's import map. The browser verifies each remote with SRI from the map's `integrity` section. Deploys and rollbacks change what the host loads — the host itself is never rebuilt.

```bash
# from the repository root: registry with dev sign-in, and the CLI
HARMONIQ_DEV_LOGIN=1 pnpm --filter @harmoniq/registry dev &
pnpm --filter @harmoniq/cli build

cd examples/import-map
node serve.mjs &          # serves host/ and remotes/ on :5050 (your CDN)
./demo.sh setup           # prints the host URL; open it → "Hello from greeting 1.0.0"
./demo.sh deploy 2.0.0    # reload → 2.0.0
./demo.sh rollback        # reload → 1.0.0
```

Browsers don't support `<script type="importmap" src>`, so the host fetches the map from `/api/importmap/…` and inlines it before importing anything. For older browsers, add [es-module-shims](https://github.com/guybedford/es-module-shims).

Try tampering: edit `remotes/greeting/1.0.0/index.js` after deploying — the browser refuses to run it because the hash no longer matches.
