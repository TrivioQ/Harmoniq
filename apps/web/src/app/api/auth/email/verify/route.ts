// Copyright The Harmoniq Authors
// SPDX-License-Identifier: Apache-2.0

import { NextRequest } from 'next/server';
import type { SignInResponse } from '@harmoniq/core/dist/schemas/AuthSchemas';
import { isSameOrigin, loginErrorRedirect, signInResponse } from '@/lib/http';
import { RegistryError, registryFetch } from '@/lib/registry';
import { EMAIL_NONCE_COOKIE } from '@/lib/session';

// Completes a magic-link sign-in. Reached by a POST from /auth/verify, never by the
// emailed GET itself, so link scanners can't consume the token.
export async function POST(request: NextRequest) {
  if (!isSameOrigin(request)) return loginErrorRedirect('invalid_origin');
  const token = String((await request.formData()).get('token') ?? '');
  const nonce = request.cookies.get(EMAIL_NONCE_COOKIE)?.value;
  if (!token) return loginErrorRedirect('invalid_token');
  if (!nonce) return loginErrorRedirect('other_browser');

  let session: SignInResponse;
  try {
    session = await registryFetch<SignInResponse>('/api/auth/email/verify', {
      body: { token, nonce },
    });
  } catch (err) {
    return loginErrorRedirect(
      err instanceof RegistryError && err.message.includes('browser')
        ? 'other_browser'
        : 'invalid_token'
    );
  }
  // The nonce cookie is left to expire: reopening a used link then reports "already used"
  // instead of "wrong browser".
  const response = signInResponse(session);
  return response;
}
