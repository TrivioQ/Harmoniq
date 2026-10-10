// Copyright The Harmoniq Authors
// SPDX-License-Identifier: Apache-2.0

/**
 * Writes docs/schema/manifest.v2.json and docs/schema/harmoniq.v1.json from the Zod schemas,
 * and the SchemaStore copy of the harmoniq.yaml schema (integrations/schemastore).
 *   pnpm --filter @harmoniq/registry schema:generate
 */
import { mkdir, writeFile } from 'fs/promises';
import { dirname, join } from 'path';
import {
  gitopsJsonSchema,
  manifestJsonSchema,
  schemaStoreGitopsSchema,
} from '../src/services/manifestJsonSchema';

const dir = join(__dirname, '../../../docs/schema');
const write = async (name: string, schema: object) => {
  const out = join(dir, name);
  await mkdir(dirname(out), { recursive: true });
  await writeFile(out, JSON.stringify(schema, null, 2) + '\n');
  console.log(`Wrote ${out}`);
};
mkdir(dir, { recursive: true })
  .then(() => write('manifest.v2.json', manifestJsonSchema()))
  .then(() => write('harmoniq.v1.json', gitopsJsonSchema()))
  .then(() =>
    write(
      '../../integrations/schemastore/src/schemas/json/harmoniq.json',
      schemaStoreGitopsSchema()
    )
  );
