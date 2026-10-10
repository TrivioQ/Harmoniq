// Copyright The Harmoniq Authors
// SPDX-License-Identifier: Apache-2.0

import { NextRequest } from 'next/server';
import { loginErrorRedirect, redirectTo } from '@/lib/http';
import { RegistryError, registryFetch } from '@/lib/registry';

// "Sign in with SSO": find the workspace whose identity provider trusts the email's
// domain, then start that provider's redirect sign-in.
export async function GET(request: NextRequest) {
  const email = request.nextUrl.searchParams.get('email')?.trim();
  if (!email) return loginErrorRedirect('email_required');
  try {
    const { provider } = await registryFetch<{ provider: string }>(
      `/api/auth/sso/discover?email=${encodeURIComponent(email)}`
    );
    return redirectTo(`/api/auth/login/${encodeURIComponent(provider)}`);
  } catch (err) {
    return loginErrorRedirect(
      err instanceof RegistryError && err.status === 404 ? 'sso_not_found' : 'provider_unavailable'
    );
  }
}
