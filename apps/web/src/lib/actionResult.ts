export type ActionResult =
  | { status: 'idle' }
  | { status: 'success'; message?: string; secret?: string }
  | { status: 'error'; message: string };
