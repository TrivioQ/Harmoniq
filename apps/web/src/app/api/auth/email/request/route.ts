import { randomBytes } from 'crypto';
import { NextRequest } from 'next/server';
import { getAppUrl } from '@/lib/env';
import { isSameOrigin, loginErrorRedirect, redirectTo } from '@/lib/http';
import { registryFetch } from '@/lib/registry';
import { setEmailNonceCookie } from '@/lib/session';

// Sends a sign-in link + code. The nonce cookie ties the link to this browser.
export async function POST(request: NextRequest) {
  if (!isSameOrigin(request)) return loginErrorRedirect('invalid_origin');
  const email = String((await request.formData()).get('email') ?? '').trim();
  if (!email) return loginErrorRedirect('email_required');

  const nonce = randomBytes(24).toString('base64url');
  try {
    await registryFetch('/api/auth/email/request', {
      body: { email, nonce, redirectUri: `${getAppUrl()}/auth/verify` },
    });
  } catch {
    return loginErrorRedirect('provider_unavailable');
  }

  const response = redirectTo(`/auth/login?sent=1&email=${encodeURIComponent(email)}`);
  setEmailNonceCookie(response.cookies, nonce);
  return response;
}
