// Copyright The Harmoniq Authors
// SPDX-License-Identifier: Apache-2.0

import { Command } from 'commander';
import { isValidBundle, validateBundle } from '@harmoniq/core/dist/validation/bundle';
import { resolveContext } from '../lib/context';
import { EXIT } from '../lib/errors';
import { resolveIntegrity } from '../lib/integrity';
import { emit } from '../lib/output';

export const validateCommand = new Command('validate')
  .description('Check that a bundle URL is reachable and matches its integrity hash')
  .requiredOption('--url <url>', 'Bundle URL')
  .option('--integrity <sri>', 'Expected SRI hash')
  .option('--file <path>', 'Local build output to compute the expected hash from')
  .action(async (opts, command: Command) => {
    const ctx = await resolveContext(command);
    const integrity = await resolveIntegrity(opts);
    const result = await validateBundle(opts.url, integrity);
    const ok = isValidBundle(result);
    if (!ctx.json) result.warnings.forEach((w) => console.error(`warning: ${w}`));
    emit(ctx, { valid: ok, integrity, ...result }, () =>
      ok
        ? `Bundle at ${opts.url} is valid (${integrity})`
        : `Invalid bundle: ${result.errors.join('; ')}`
    );
    if (!ok) process.exitCode = EXIT.validation;
  });
