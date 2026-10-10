// Copyright The Harmoniq Authors
// SPDX-License-Identifier: Apache-2.0

import { zodToJsonSchema } from 'zod-to-json-schema';
import { ManifestSchema } from '@harmoniq/core/dist/schemas/ManifestSchema';
import { GitOpsConfigSchema } from '@harmoniq/core/dist/schemas/GitOpsConfigSchema';

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

export const GITOPS_SCHEMA_ID = 'urn:harmoniq:schema:harmoniq-yaml:v1';

/**
 * IaC-09: JSON Schema for `harmoniq.yaml` (editor completion and validation, e.g.
 * `# yaml-language-server: $schema=…/api/schema/harmoniq.json`). Unknown keys are errors,
 * as in the registry.
 */
export function gitopsJsonSchema() {
  return {
    $id: GITOPS_SCHEMA_ID,
    title: 'Harmoniq workspace configuration (harmoniq.yaml, version 1)',
    ...withoutUriFormat(
      zodToJsonSchema(GitOpsConfigSchema, { $refStrategy: 'none', target: 'jsonSchema7' }),
      TEMPLATE_FIELDS
    ),
  };
}

/**
 * URL templates hold placeholders (`{environment}`, `{id}`) that RFC 3986 — and so JSON
 * Schema's `uri` format — rejects, while the registry (WHATWG URL parsing) accepts them.
 */
const TEMPLATE_FIELDS = new Set(['previewUrlTemplate', 'ticketUrlPattern']);

function withoutUriFormat<T>(node: T, fields: Set<string>, inField = false): T {
  if (Array.isArray(node)) return node.map((n) => withoutUriFormat(n, fields, inField)) as T;
  if (!node || typeof node !== 'object') return node;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    if (inField && key === 'format' && value === 'uri') continue;
    if (key === 'properties' && value && typeof value === 'object') {
      out[key] = Object.fromEntries(
        Object.entries(value as Record<string, unknown>).map(([name, prop]) => [
          name,
          withoutUriFormat(prop, fields, fields.has(name)),
        ])
      );
    } else {
      out[key] = withoutUriFormat(value, fields, inField);
    }
  }
  return out as T;
}

/** The copy submitted to SchemaStore (served there as json.schemastore.org/harmoniq.json). */
export function schemaStoreGitopsSchema() {
  return {
    ...gitopsJsonSchema(),
    $id: 'https://json.schemastore.org/harmoniq.json',
    description:
      'Declared state of a Harmoniq workspace, applied with `harmoniq apply`: host apps, environments, approval policies, freezes, modules and owners, webhooks, alert rules. https://github.com/TrivioQ/Harmoniq/blob/main/docs/features/gitops.md',
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
