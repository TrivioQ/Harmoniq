/** Exit codes are part of the CLI contract: CI pipelines branch on them. */
export const EXIT = {
  ok: 0,
  generic: 1,
  validation: 2,
  auth: 3,
  frozen: 4,
  conflict: 5,
  /** The change waits for approval (APR-04); `--wait` to block until it is decided. */
  pending: 6,
} as const;

export class CliError extends Error {
  constructor(
    message: string,
    public readonly exitCode: number = EXIT.generic,
    public readonly details?: unknown
  ) {
    super(message);
    this.name = 'CliError';
  }
}

export function exitCodeForStatus(status: number): number {
  if (status === 401 || status === 403) return EXIT.auth;
  if (status === 400 || status === 422) return EXIT.validation;
  if (status === 423) return EXIT.frozen;
  if (status === 409) return EXIT.conflict;
  return EXIT.generic;
}
