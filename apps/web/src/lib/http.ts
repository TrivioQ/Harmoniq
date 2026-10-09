import { NextRequest, NextResponse } from 'next/server';
import { getAppUrl } from './env';

/**
 * CSRF guard for state-changing POST route handlers: browsers always send `Origin` on
 * cross-site POSTs, so requiring our own origin blocks forged logout/login submissions.
 */
export function isSameOrigin(request: NextRequest): boolean {
  const origin = request.headers.get('origin');
  return !!origin && origin === new URL(getAppUrl()).origin;
}

/** Redirect to a dashboard path. 303 so a POST is followed by a GET. */
export function redirectTo(path: string, status: 303 | 307 = 303): NextResponse {
  return NextResponse.redirect(new URL(path, getAppUrl()), status);
}

export function loginErrorRedirect(reason: string): NextResponse {
  return redirectTo(`/auth/login?error=${encodeURIComponent(reason)}`);
}
