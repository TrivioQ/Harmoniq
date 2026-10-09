/**
 * Writes docs/schema/manifest.v2.json from the Zod schema.
 *   pnpm --filter @harmoniq/registry schema:generate
 */
import { mkdir, writeFile } from 'fs/promises';
import { dirname, join } from 'path';
import { manifestJsonSchema } from '../src/services/manifestJsonSchema';

const out = join(__dirname, '../../../docs/schema/manifest.v2.json');
mkdir(dirname(out), { recursive: true })
  .then(() => writeFile(out, JSON.stringify(manifestJsonSchema(), null, 2) + '\n'))
  .then(() => console.log(`Wrote ${out}`));
