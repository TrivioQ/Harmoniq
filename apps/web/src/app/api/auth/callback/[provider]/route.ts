// Copyright The Harmoniq Authors
// SPDX-License-Identifier: Apache-2.0

import { createHash, timingSafeEqual } from 'crypto';
import { NextRequest } from 'next/server';
import type { SignInResponse } from '@harmoniq/core/dist/schemas/AuthSchemas';
import { getAppUrl } from '@/lib/env';
import { loginErrorRedirect, signInResponse } from '@/lib/http';
import { RegistryError, registryFetch } from '@/lib/registry';
import { OAUTH_STATE_COOKIE, OAUTH_VERIFIER_COOKIE, clearOAuthCookies } from '@/lib/session';

const sameValue = (a: string, b: string) => {
  const ha = createHash('sha256').update(a).digest();
  const hb = createHash('sha256').update(b).digest();
  return timingSafeEqual(ha, hb);
};

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ provider: string }> }
) {
  const { provider } = await params;
  const query = request.nextUrl.searchParams;
  const code = query.get('code');
  const state = query.get('state');
  const expectedState = request.cookies.get(OAUTH_STATE_COOKIE)?.value;
  const verifier = request.cookies.get(OAUTH_VERIFIER_COOKIE)?.value;

  const fail = (reason: string) => {
    const response = loginErrorRedirect(reason);
    clearOAuthCookies(response.cookies);
    return response;
  };

  if (query.get('error')) return fail('access_denied');
  // The state must match the one this browser started with (login CSRF protection).
  if (!code || !state || !expectedState || !verifier || !sameValue(state, expectedState)) {
    return fail('invalid_state');
  }

  let session: SignInResponse;
  try {
    session = await registryFetch<SignInResponse>(
      `/api/auth/${encodeURIComponent(provider)}/callback`,
      {
        body: {
          code,
          codeVerifier: verifier,
          redirectUri: `${getAppUrl()}/api/auth/callback/${encodeURIComponent(provider)}`,
        },
      }
    );
  } catch (err) {
    return fail(err instanceof RegistryError ? err.code.toLowerCase() : 'sign_in_failed');
  }

  const response = signInResponse(session);
  clearOAuthCookies(response.cookies);
  return response;
}
