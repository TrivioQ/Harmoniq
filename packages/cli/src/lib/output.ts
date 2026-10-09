import { Context } from './context';

/** `--json` prints exactly one JSON document to stdout; otherwise a human line. */
export function emit(ctx: Context, data: unknown, human: string | (() => string)) {
  if (ctx.json) {
    console.log(JSON.stringify(data));
  } else {
    console.log(typeof human === 'function' ? human() : human);
  }
}

export const enc = encodeURIComponent;
