// Copyright The Harmoniq Authors
// SPDX-License-Identifier: Apache-2.0

import { NextRequest } from 'next/server';
import type { SignInResponse } from '@harmoniq/core/dist/schemas/AuthSchemas';
import { loginErrorRedirect, signInResponse } from '@/lib/http';
import { RegistryError, registryFetch } from '@/lib/registry';

// SSO-09: an IdP-initiated SAML login (the workspace opted in). The registry's ACS issued
// a one-time code; there is no state to check because this browser started nothing.
export async function GET(request: NextRequest) {
  const code = request.nextUrl.searchParams.get('code');
  const provider = request.nextUrl.searchParams.get('provider');
  if (!code || !provider?.startsWith('saml:')) return loginErrorRedirect('invalid_state');

  let session: SignInResponse;
  try {
    session = await registryFetch<SignInResponse>('/api/auth/saml/redeem', {
      body: { code, provider },
    });
  } catch (err) {
    return loginErrorRedirect(
      err instanceof RegistryError ? err.code.toLowerCase() : 'sign_in_failed'
    );
  }
  const response = signInResponse(session);
  return response;
}
