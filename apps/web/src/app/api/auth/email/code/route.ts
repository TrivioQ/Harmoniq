// Copyright The Harmoniq Authors
// SPDX-License-Identifier: Apache-2.0

import { NextRequest } from 'next/server';
import type { SignInResponse } from '@harmoniq/core/dist/schemas/AuthSchemas';
import { isSameOrigin, loginErrorRedirect, redirectTo, signInResponse } from '@/lib/http';
import { registryFetch } from '@/lib/registry';
import { clearEmailNonceCookie } from '@/lib/session';

// Completes sign-in with the 6-digit code (works on any device).
export async function POST(request: NextRequest) {
  if (!isSameOrigin(request)) return loginErrorRedirect('invalid_origin');
  const form = await request.formData();
  const email = String(form.get('email') ?? '').trim();
  const code = String(form.get('code') ?? '').replace(/\s/g, '');

  let session: SignInResponse;
  try {
    session = await registryFetch<SignInResponse>('/api/auth/email/verify', {
      body: { email, code },
    });
  } catch {
    return redirectTo(`/auth/login?sent=1&email=${encodeURIComponent(email)}&error=invalid_code`);
  }
  const response = signInResponse(session);
  clearEmailNonceCookie(response.cookies);
  return response;
}
