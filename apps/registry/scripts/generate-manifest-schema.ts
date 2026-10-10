/**
 * Writes docs/schema/manifest.v2.json and docs/schema/harmoniq.v1.json from the Zod schemas.
 *   pnpm --filter @harmoniq/registry schema:generate
 */
import { mkdir, writeFile } from 'fs/promises';
import { join } from 'path';
import { gitopsJsonSchema, manifestJsonSchema } from '../src/services/manifestJsonSchema';

const dir = join(__dirname, '../../../docs/schema');
const write = async (name: string, schema: object) => {
  const out = join(dir, name);
  await writeFile(out, JSON.stringify(schema, null, 2) + '\n');
  console.log(`Wrote ${out}`);
};
mkdir(dir, { recursive: true })
  .then(() => write('manifest.v2.json', manifestJsonSchema()))
  .then(() => write('harmoniq.v1.json', gitopsJsonSchema()));
