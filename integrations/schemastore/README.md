# SchemaStore submission: `harmoniq.yaml`

Editors that use [SchemaStore](https://www.schemastore.org) (VS Code with the YAML extension, JetBrains IDEs) will validate and autocomplete `harmoniq.yaml` once this schema is in the catalog. This directory mirrors the layout of the SchemaStore repository, ready for a pull request.

| Here                                              | In `SchemaStore/schemastore`                                              |
| ------------------------------------------------- | ------------------------------------------------------------------------- |
| `src/schemas/json/harmoniq.json`                  | same path (generated: `pnpm --filter @harmoniq/registry schema:generate`) |
| `src/test/harmoniq/harmoniq.yaml`                 | same path (must validate)                                                 |
| `src/negative_test/harmoniq/unknown-version.yaml` | same path (must not validate)                                             |
| `catalog-entry.json`                              | an entry in the `schemas` array of `src/api/json/catalog.json`            |

The registry test `schemaStore.test.ts` checks that the schema matches the Zod schema the registry applies, and that the test files pass and fail as SchemaStore expects.

Until the entry is accepted, point the YAML extension at the registry itself:

```yaml
# yaml-language-server: $schema=https://registry.acme.dev/api/schema/harmoniq.json
```

## Submitting (maintainers)

1. Fork `SchemaStore/schemastore`, copy the three files to the paths above and add the catalog entry (keep the catalog sorted by name).
2. Run their checks (`npm run check`) and open the pull request. Mention that the schema is generated from the Harmoniq source and will be updated with each schema version.
