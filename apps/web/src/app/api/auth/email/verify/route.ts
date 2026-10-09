import { NextRequest } from 'next/server';
import type { SessionResponse } from '@harmoniq/core/dist/schemas/AuthSchemas';
import { isSameOrigin, loginErrorRedirect, redirectTo } from '@/lib/http';
import { RegistryError, registryFetch } from '@/lib/registry';
import { EMAIL_NONCE_COOKIE, setSessionCookies } from '@/lib/session';

// Completes a magic-link sign-in. Reached by a POST from /auth/verify, never by the
// emailed GET itself, so link scanners can't consume the token.
export async function POST(request: NextRequest) {
  if (!isSameOrigin(request)) return loginErrorRedirect('invalid_origin');
  const token = String((await request.formData()).get('token') ?? '');
  const nonce = request.cookies.get(EMAIL_NONCE_COOKIE)?.value;
  if (!token) return loginErrorRedirect('invalid_token');
  if (!nonce) return loginErrorRedirect('other_browser');

  let session: SessionResponse;
  try {
    session = await registryFetch<SessionResponse>('/api/auth/email/verify', {
      body: { token, nonce },
    });
  } catch (err) {
    return loginErrorRedirect(
      err instanceof RegistryError && err.message.includes('browser')
        ? 'other_browser'
        : 'invalid_token'
    );
  }
  const response = redirectTo('/');
  // The nonce cookie is left to expire: reopening a used link then reports "already used"
  // instead of "wrong browser".
  setSessionCookies(response.cookies, session);
  return response;
}
