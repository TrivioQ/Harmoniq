// Copyright The Harmoniq Authors
// SPDX-License-Identifier: Apache-2.0

import { NextRequest } from 'next/server';
import type { SessionResponse } from '@harmoniq/core/dist/schemas/AuthSchemas';
import { isSameOrigin, loginErrorRedirect, redirectTo } from '@/lib/http';
import { RegistryError, registryFetch } from '@/lib/registry';
import { MFA_COOKIE, clearMfaCookie, setSessionCookies } from '@/lib/session';

/** SES-03: the second step of a sign-in: the challenge (cookie) and the code (form). */
export async function POST(request: NextRequest) {
  if (!isSameOrigin(request)) return loginErrorRedirect('invalid_origin');
  const challenge = request.cookies.get(MFA_COOKIE)?.value;
  if (!challenge) return loginErrorRedirect('mfa_expired');
  const form = await request.formData();
  const code = String(form.get('code') ?? '').trim();

  let session: SessionResponse;
  try {
    session = await registryFetch<SessionResponse>('/api/auth/mfa/verify', {
      body: { challenge, code },
    });
  } catch (err) {
    const reason = err instanceof RegistryError ? err.code.toLowerCase() : 'sign_in_failed';
    // A wrong code: try again while the challenge lasts; otherwise start over.
    if (reason === 'mfa_invalid' || reason === 'bad_request') {
      return redirectTo('/auth/mfa?error=mfa_invalid');
    }
    const response = loginErrorRedirect(reason);
    clearMfaCookie(response.cookies);
    return response;
  }
  const response = redirectTo('/');
  setSessionCookies(response.cookies, session);
  clearMfaCookie(response.cookies);
  return response;
}
