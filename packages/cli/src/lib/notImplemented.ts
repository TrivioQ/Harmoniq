/**
 * Commands that are declared but not yet backed by the registry API. They must fail
 * loudly: a CI pipeline or incident runbook that sees exit 0 will assume the rollback,
 * promotion or validation happened.
 */
export function notImplemented(command: string): never {
  console.error(
    `harmoniq ${command}: not implemented yet. Nothing was changed. ` +
      'See docs/cli.md for supported commands.'
  );
  process.exit(1);
}
