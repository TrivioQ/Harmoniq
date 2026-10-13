// Copyright The Harmoniq Authors
// SPDX-License-Identifier: Apache-2.0

import { NextRequest, NextResponse } from 'next/server';
import { getAppUrl } from './env';
import type { SignInResponse } from '@harmoniq/core/dist/schemas/AuthSchemas';
import { setMfaCookie, setSessionCookies } from './session';

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

/**
 * After the first factor: the session, or (SES-03) the code page with the challenge in an
 * HttpOnly cookie when the account uses MFA.
 */
export function signInResponse(result: SignInResponse, to = '/'): NextResponse {
  if ('mfaRequired' in result) {
    const response = redirectTo('/auth/mfa');
    setMfaCookie(response.cookies, result.challenge);
    return response;
  }
  const response = redirectTo(to);
  setSessionCookies(response.cookies, result);
  return response;
}
