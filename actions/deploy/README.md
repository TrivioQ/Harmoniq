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

Preview environment per pull request (the workspace must allow preview environments; set a preview URL template on the host app to get a link):

```yaml
- uses: ./actions/deploy
  id: preview
  with:
    registry-url: https://registry.acme.dev
    api-key: ${{ secrets.HARMONIQ_API_KEY }}
    workspace: acme
    module: checkout
    environment: pr-${{ github.event.number }}
    preview-ttl-hours: 72
    version: ${{ github.sha }}
    url: https://cdn.acme.dev/checkout/${{ github.sha }}/remoteEntry.js
    file: dist/remoteEntry.js
- run: gh pr comment ${{ github.event.number }} --body "Preview: ${{ steps.preview.outputs.preview-url }}"
  env:
    GH_TOKEN: ${{ github.token }}
```

Upload the build output to your CDN before this step. The step fails with the CLI's exit code (e.g. `4` when the target environment is frozen). Outputs: `version-id`, `manifest-etag`, `preview-url`.
