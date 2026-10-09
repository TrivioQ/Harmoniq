import { createHash, randomBytes } from 'crypto';
import { NextRequest, NextResponse } from 'next/server';
import { getAppUrl } from '@/lib/env';
import { loginErrorRedirect } from '@/lib/http';
import { registryFetch } from '@/lib/registry';
import { setOAuthCookies } from '@/lib/session';

// Starts a redirect sign-in: generates state + PKCE verifier, keeps them in short-lived
// HttpOnly cookies, and sends the browser to the provider via the registry.
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ provider: string }> }
) {
  const { provider } = await params;
  const state = randomBytes(24).toString('base64url');
  const verifier = randomBytes(32).toString('base64url');
  const codeChallenge = createHash('sha256').update(verifier).digest('base64url');

  let authorizationUrl: string;
  try {
    ({ authorizationUrl } = await registryFetch<{ authorizationUrl: string }>(
      `/api/auth/${encodeURIComponent(provider)}/start`,
      {
        body: {
          state,
          codeChallenge,
          redirectUri: `${getAppUrl()}/api/auth/callback/${encodeURIComponent(provider)}`,
        },
      }
    ));
  } catch {
    return loginErrorRedirect('provider_unavailable');
  }

  const response = NextResponse.redirect(authorizationUrl);
  setOAuthCookies(response.cookies, state, verifier);
  return response;
}
