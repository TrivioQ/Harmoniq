// Copyright The Harmoniq Authors
// SPDX-License-Identifier: Apache-2.0

import { readFile } from 'fs/promises';
import { computeIntegrity } from '@harmoniq/core/dist/validation/bundle';
import { CliError, EXIT } from './errors';

const MAX_BUNDLE_BYTES = 20 * 1024 * 1024;

const toArrayBuffer = (content: Uint8Array) =>
  content.buffer.slice(content.byteOffset, content.byteOffset + content.byteLength) as ArrayBuffer;

/**
 * Integrity from `--integrity`, or computed (sha384) from a local `--file`, or else from
 * the bundle downloaded from `--url` (IaC-06: the hash of what browsers will load).
 */
export async function resolveIntegrity(opts: {
  integrity?: string;
  file?: string;
  url?: string;
}): Promise<string> {
  if (opts.integrity) return opts.integrity;
  if (opts.file) {
    const content = await readFile(opts.file).catch(() => {
      throw new CliError(`Cannot read ${opts.file}`, EXIT.validation);
    });
    return computeIntegrity(toArrayBuffer(content), 'sha384');
  }
  if (opts.url) return integrityOfUrl(opts.url);
  throw new CliError('Pass --integrity <sri> or --file <path> to compute it', EXIT.validation);
}

async function integrityOfUrl(url: string): Promise<string> {
  let res: Response;
  try {
    // A redirect would hash something other than the deployed URL.
    res = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(30_000) });
  } catch (err) {
    throw new CliError(
      `Cannot download ${url} to compute its integrity (${(err as Error).message}); pass --integrity or --file`,
      EXIT.validation
    );
  }
  if (!res.ok) {
    throw new CliError(
      `Downloading ${url} to compute its integrity returned HTTP ${res.status}; upload the bundle first, or pass --integrity or --file`,
      EXIT.validation
    );
  }
  const content = new Uint8Array(await res.arrayBuffer());
  if (content.byteLength > MAX_BUNDLE_BYTES) {
    throw new CliError(`${url} is larger than ${MAX_BUNDLE_BYTES} bytes`, EXIT.validation);
  }
  return computeIntegrity(toArrayBuffer(content), 'sha384');
}
