import { NextRequest, NextResponse } from 'next/server';
import createMiddleware from 'next-intl/middleware';
import type { SessionResponse } from '@harmoniq/core/dist/schemas/AuthSchemas';
import { routing } from './i18n/routing';
import { getRegistryUrl } from './lib/env';
import {
  ACCESS_COOKIE,
  REFRESH_COOKIE,
  isValidAccessToken,
  setSessionCookies,
} from './lib/session';

const intlMiddleware = createMiddleware(routing);

const localePrefix = `(?:/(?:${routing.locales.join('|')}))?`;
// Reachable without a session. /admin/setup is the first-boot wizard (no users exist yet).
const PUBLIC_PATH = new RegExp(`^${localePrefix}/(?:auth|admin/setup)(?:/|$)`);
const LOGIN_PATH = new RegExp(`^${localePrefix}/auth/login/?$`);

async function refreshSession(
  refreshToken: string,
  forwardedFor: string | null
): Promise<SessionResponse | null> {
  try {
    const res = await fetch(`${getRegistryUrl()}/api/auth/refresh`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(forwardedFor && { 'X-Forwarded-For': forwardedFor }),
      },
      body: JSON.stringify({ refreshToken }),
      cache: 'no-store',
    });
    return res.ok ? ((await res.json()) as SessionResponse) : null;
  } catch {
    return null;
  }
}

/**
 * Optimistic session check (the registry still authorizes every call) plus transparent
 * refresh: when the 15-minute access token has expired, rotate it here so pages and
 * server actions render with a valid token in the same request.
 */
export default async function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;
  const isPublic = PUBLIC_PATH.test(pathname);
  const isLogin = LOGIN_PATH.test(pathname);

  if (await isValidAccessToken(request.cookies.get(ACCESS_COOKIE)?.value)) {
    return isLogin ? NextResponse.redirect(new URL('/', request.url)) : intlMiddleware(request);
  }

  const refreshToken = request.cookies.get(REFRESH_COOKIE)?.value;
  const session = refreshToken
    ? await refreshSession(refreshToken, request.headers.get('x-forwarded-for'))
    : null;
  if (session) {
    // Update the incoming request too: next-intl forwards these headers downstream, so
    // server components see the new token without another round trip.
    request.cookies.set(ACCESS_COOKIE, session.accessToken);
    request.cookies.set(REFRESH_COOKIE, session.refreshToken);
    const response = isLogin
      ? NextResponse.redirect(new URL('/', request.url))
      : intlMiddleware(request);
    setSessionCookies(response.cookies, session);
    return response;
  }

  // A failed refresh may just be a parallel request that lost the rotation race; don't
  // clear cookies here or we'd wipe the winner's fresh session. Sign-out clears them.
  if (isPublic) return intlMiddleware(request);
  return NextResponse.redirect(new URL('/auth/login', request.url));
}

export const config = {
  // Everything except API routes, Next internals and files with an extension.
  matcher: ['/((?!api|_next|_vercel|.*\\..*).*)'],
};
