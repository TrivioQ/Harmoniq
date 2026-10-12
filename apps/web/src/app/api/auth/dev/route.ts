// Copyright The Harmoniq Authors
// SPDX-License-Identifier: Apache-2.0

import { NextRequest } from 'next/server';
import type { SignInResponse } from '@harmoniq/core/dist/schemas/AuthSchemas';
import { isSameOrigin, loginErrorRedirect, signInResponse } from '@/lib/http';
import { RegistryError, registryFetch } from '@/lib/registry';

// Development sign-in. The registry only exposes it when HARMONIQ_DEV_LOGIN is set, and
// refuses to start with it in production.
export async function POST(request: NextRequest) {
  if (!isSameOrigin(request)) return loginErrorRedirect('invalid_origin');

  const form = await request.formData();
  const email = String(form.get('email') ?? '').trim();
  if (!email) return loginErrorRedirect('email_required');

  let session: SignInResponse;
  try {
    session = await registryFetch<SignInResponse>('/api/auth/dev/login', { body: { email } });
  } catch (err) {
    return loginErrorRedirect(
      err instanceof RegistryError && err.status === 404 ? 'dev_login_disabled' : 'sign_in_failed'
    );
  }

  const response = signInResponse(session);
  return response;
}
