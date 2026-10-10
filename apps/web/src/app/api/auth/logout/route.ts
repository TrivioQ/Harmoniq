// Copyright The Harmoniq Authors
// SPDX-License-Identifier: Apache-2.0

import { NextRequest } from 'next/server';
import { isSameOrigin, redirectTo } from '@/lib/http';
import { registryFetch } from '@/lib/registry';
import { REFRESH_COOKIE, clearSessionCookies } from '@/lib/session';

// POST only, same-origin only: a GET logout lets any page sign users out cross-site.
export async function POST(request: NextRequest) {
  if (!isSameOrigin(request)) {
    return new Response('Forbidden', { status: 403 });
  }

  const refreshToken = request.cookies.get(REFRESH_COOKIE)?.value;
  if (refreshToken) {
    // Revoke server-side so a copied cookie stops working too. Best effort: the cookies
    // are cleared below regardless.
    await registryFetch('/api/auth/logout', { body: { refreshToken } }).catch(() => undefined);
  }

  const response = redirectTo('/auth/login');
  clearSessionCookies(response.cookies);
  return response;
}
