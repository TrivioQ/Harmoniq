#!/usr/bin/env node
// Copyright The Harmoniq Authors
// SPDX-License-Identifier: Apache-2.0

/**
 * Every tracked source file starts with the Apache-2.0 SPDX header (after a shebang).
 *
 *   pnpm run license:check        list files without it (exit 1 if any)
 *   pnpm run license:check --fix  add it
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';

const HOLDER = 'Copyright The Harmoniq Authors';
const SPDX = 'SPDX-License-Identifier: Apache-2.0';
const COMMENT = {
  ts: '//',
  tsx: '//',
  js: '//',
  mjs: '//',
  cjs: '//',
  go: '//',
  py: '#',
  tf: '#',
};
// Generated or vendored: declarations, Next.js' own env types, build output.
const SKIP = [/\.d\.ts$/, /(^|\/)(dist|build|\.next|node_modules)\//];

const fix = process.argv.includes('--fix');
const files = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], {
  encoding: 'utf8',
})
  .split('\0')
  .filter((file) => file && !SKIP.some((re) => re.test(file)))
  .filter((file) => (file.split('.').pop() ?? '') in COMMENT);

const missing = [];
for (const file of files) {
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    continue; // Deleted in the working tree.
  }
  if (text.split('\n', 6).some((line) => line.includes('SPDX-License-Identifier'))) continue;
  missing.push(file);
  if (!fix) continue;

  const c = COMMENT[file.split('.').pop()];
  const header = `${c} ${HOLDER}\n${c} ${SPDX}\n`;
  const shebang = text.startsWith('#!') ? text.slice(0, text.indexOf('\n') + 1) : '';
  const rest = text.slice(shebang.length);
  writeFileSync(file, `${shebang}${header}${rest.startsWith('\n') ? '' : '\n'}${rest}`);
}

if (fix) {
  console.log(`Added the license header to ${missing.length} file(s).`);
} else if (missing.length) {
  console.error(`Missing the SPDX license header (run \`pnpm run license:check --fix\`):`);
  for (const file of missing) console.error(`  ${file}`);
  process.exit(1);
} else {
  console.log(`License headers: ${files.length} files OK.`);
}
