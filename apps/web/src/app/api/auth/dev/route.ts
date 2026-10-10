// Copyright The Harmoniq Authors
// SPDX-License-Identifier: Apache-2.0

import { NextRequest } from 'next/server';
import type { SessionResponse } from '@harmoniq/core/dist/schemas/AuthSchemas';
import { isSameOrigin, loginErrorRedirect, redirectTo } from '@/lib/http';
import { RegistryError, registryFetch } from '@/lib/registry';
import { setSessionCookies } from '@/lib/session';

// Development sign-in. The registry only exposes it when HARMONIQ_DEV_LOGIN is set, and
// refuses to start with it in production.
export async function POST(request: NextRequest) {
  if (!isSameOrigin(request)) return loginErrorRedirect('invalid_origin');

  const form = await request.formData();
  const email = String(form.get('email') ?? '').trim();
  if (!email) return loginErrorRedirect('email_required');

  let session: SessionResponse;
  try {
    session = await registryFetch<SessionResponse>('/api/auth/dev/login', { body: { email } });
  } catch (err) {
    return loginErrorRedirect(
      err instanceof RegistryError && err.status === 404 ? 'dev_login_disabled' : 'sign_in_failed'
    );
  }

  const response = redirectTo('/');
  setSessionCookies(response.cookies, session);
  return response;
}
