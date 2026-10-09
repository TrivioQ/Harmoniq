import { readFile } from 'fs/promises';
import { computeIntegrity } from '@harmoniq/core/dist/validation/bundle';
import { CliError, EXIT } from './errors';

/** Integrity from `--integrity`, or computed (sha384) from a local `--file`. */
export async function resolveIntegrity(opts: {
  integrity?: string;
  file?: string;
}): Promise<string> {
  if (opts.integrity) return opts.integrity;
  if (opts.file) {
    const content = await readFile(opts.file).catch(() => {
      throw new CliError(`Cannot read ${opts.file}`, EXIT.validation);
    });
    const bytes = content.buffer.slice(
      content.byteOffset,
      content.byteOffset + content.byteLength
    ) as ArrayBuffer;
    return computeIntegrity(bytes, 'sha384');
  }
  throw new CliError('Pass --integrity <sri> or --file <path> to compute it', EXIT.validation);
}
