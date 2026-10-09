import { zodToJsonSchema } from 'zod-to-json-schema';
import { ManifestSchema } from '@harmoniq/core/dist/schemas/ManifestSchema';

export const MANIFEST_SCHEMA_ID = 'urn:harmoniq:schema:manifest:v2';

/**
 * Public JSON Schema for manifest schemaVersion 2, generated from the Zod schema the
 * registry itself validates against, so the two can't drift.
 */
export function manifestJsonSchema() {
  return {
    $id: MANIFEST_SCHEMA_ID,
    title: 'Harmoniq manifest (schemaVersion 2)',
    ...allowUnknownProperties(
      zodToJsonSchema(ManifestSchema, { $refStrategy: 'none', target: 'jsonSchema7' })
    ),
  };
}

/**
 * Zod strips unknown keys rather than rejecting them; mirror that so tools validating
 * against this schema accept manifests from newer registries with additional fields.
 */
function allowUnknownProperties<T>(node: T): T {
  if (Array.isArray(node)) return node.map(allowUnknownProperties) as T;
  if (node && typeof node === 'object') {
    const entries = Object.entries(node as Record<string, unknown>)
      .filter(([key, value]) => !(key === 'additionalProperties' && value === false))
      .map(([key, value]) => [key, allowUnknownProperties(value)]);
    return Object.fromEntries(entries) as T;
  }
  return node;
}
