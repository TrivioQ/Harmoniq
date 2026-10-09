# Harmoniq deploy action

Deploys a module version (or promotes one between environments) and writes a job summary.

```yaml
- uses: ./actions/deploy # or <org>/harmoniq/actions/deploy@v1
  with:
    registry-url: https://registry.acme.dev
    api-key: ${{ secrets.HARMONIQ_API_KEY }}
    workspace: acme
    module: checkout
    environment: staging
    version: ${{ github.sha }}
    url: https://cdn.acme.dev/checkout/${{ github.sha }}/remoteEntry.js
    file: dist/remoteEntry.js # integrity is computed from the built file

- uses: ./actions/deploy
  with:
    registry-url: https://registry.acme.dev
    api-key: ${{ secrets.HARMONIQ_API_KEY }}
    workspace: acme
    module: checkout
    promote-from: staging
    environment: production
```

Upload the build output to your CDN before this step. The step fails with the CLI's exit code (e.g. `4` when the target environment is frozen). Outputs: `version-id`, `manifest-etag`.
