// Copyright The Harmoniq Authors
// SPDX-License-Identifier: Apache-2.0

/**
 * Writes docs/openapi.json from the registry's routes (OAS-01/02).
 *   pnpm --filter @harmoniq/registry openapi:generate
 * Needs the database the registry starts against (instance settings load at startup).
 * `openapi.test.ts` fails when the committed file is out of date.
 */
import { writeFile } from 'fs/promises';
import { join } from 'path';
import { buildApp } from '../src/app';
import { openapiDocument } from '../src/openapiDocument';

(async () => {
  const app = await buildApp();
  await app.ready();
  const out = join(__dirname, '../../../docs/openapi.json');
  await writeFile(out, openapiDocument(app));
  console.log(`Wrote ${out}`);
  await app.close();
})();
