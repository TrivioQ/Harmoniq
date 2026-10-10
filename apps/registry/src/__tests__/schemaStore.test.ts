// Copyright The Harmoniq Authors
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import { parse } from 'yaml';
import { GitOpsConfigSchema } from '@harmoniq/core/dist/schemas/GitOpsConfigSchema';
import { schemaStoreGitopsSchema } from '../services/manifestJsonSchema';

// The SchemaStore submission (integrations/schemastore) for harmoniq.yaml.
const dir = join(__dirname, '../../../../integrations/schemastore/src');
const read = (path: string) => readFileSync(join(dir, path), 'utf8');

describe('SchemaStore submission for harmoniq.yaml', () => {
  const schema = JSON.parse(read('schemas/json/harmoniq.json'));

  it('matches the schema the registry applies (run `schema:generate` if not)', () => {
    expect(schema).toEqual(schemaStoreGitopsSchema());
    expect(schema.$id).toBe('https://json.schemastore.org/harmoniq.json');
  });

  it('accepts its test file and rejects its negative test file, like the registry', () => {
    const ajv = new Ajv({ strict: false, allErrors: true });
    addFormats(ajv);
    const validate = ajv.compile(schema);

    const positive = parse(read('test/harmoniq/harmoniq.yaml'));
    validate(positive);
    expect(validate.errors ?? []).toEqual([]);
    expect(GitOpsConfigSchema.safeParse(positive).success).toBe(true);

    const negative = parse(read('negative_test/harmoniq/unknown-version.yaml'));
    expect(validate(negative)).toBe(false);
    expect(GitOpsConfigSchema.safeParse(negative).success).toBe(false);
  });
});
