import { jwtVerify } from 'jose';
import type { SessionResponse } from '@harmoniq/core/dist/schemas/AuthSchemas';
import { getJwtKey } from './env';

// Sessions are issued by the registry; the dashboard only stores them in HttpOnly cookies.
export const ACCESS_COOKIE = 'hq_session';
export const REFRESH_COOKIE = 'hq_refresh';
export const OAUTH_STATE_COOKIE = 'hq_oauth_state';
export const OAUTH_VERIFIER_COOKIE = 'hq_oauth_verifier';
/** Binds an emailed sign-in link to the browser that requested it. */
export const EMAIL_NONCE_COOKIE = 'hq_email_nonce';

// Must match apps/registry/src/auth/tokens.ts.
const SESSION_AUDIENCE = 'harmoniq-session';

/** Anything with Next's cookie `set` signature: `cookies()` store or `response.cookies`. */
interface CookieWriter {
  set(name: string, value: string, options: Record<string, unknown>): unknown;
}

const baseCookie = () => ({
  httpOnly: true,
  secure: process.env.NODE_ENV === 'production',
  sameSite: 'lax' as const,
  path: '/',
});

export function setSessionCookies(store: CookieWriter, session: SessionResponse) {
  store.set(ACCESS_COOKIE, session.accessToken, {
    ...baseCookie(),
    expires: new Date(session.accessTokenExpiresAt),
  });
  store.set(REFRESH_COOKIE, session.refreshToken, {
    ...baseCookie(),
    expires: new Date(session.refreshTokenExpiresAt),
  });
}

export function clearSessionCookies(store: CookieWriter) {
  for (const name of [ACCESS_COOKIE, REFRESH_COOKIE]) {
    store.set(name, '', { ...baseCookie(), maxAge: 0 });
  }
}

/** Short-lived cookies holding OAuth state + PKCE verifier between redirect and callback. */
export function setOAuthCookies(store: CookieWriter, state: string, verifier: string) {
  const options = { ...baseCookie(), maxAge: 10 * 60 };
  store.set(OAUTH_STATE_COOKIE, state, options);
  store.set(OAUTH_VERIFIER_COOKIE, verifier, options);
}

export function clearOAuthCookies(store: CookieWriter) {
  for (const name of [OAUTH_STATE_COOKIE, OAUTH_VERIFIER_COOKIE]) {
    store.set(name, '', { ...baseCookie(), maxAge: 0 });
  }
}

/**
 * Optimistic check for the proxy: signature, audience and expiry only. Authorization
 * is always decided by the registry.
 */
export async function isValidAccessToken(token: string | undefined): Promise<boolean> {
  if (!token) return false;
  try {
    await jwtVerify(token, getJwtKey(), { algorithms: ['HS256'], audience: SESSION_AUDIENCE });
    return true;
  } catch {
    return false;
  }
}

export function setEmailNonceCookie(store: CookieWriter, nonce: string) {
  store.set(EMAIL_NONCE_COOKIE, nonce, { ...baseCookie(), maxAge: 15 * 60 });
}

export function clearEmailNonceCookie(store: CookieWriter) {
  store.set(EMAIL_NONCE_COOKIE, '', { ...baseCookie(), maxAge: 0 });
}
