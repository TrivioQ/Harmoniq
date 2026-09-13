import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { decrypt } from './lib/auth';
import createMiddleware from 'next-intl/middleware';
import {routing} from './i18n/routing';

const intlMiddleware = createMiddleware(routing);

export async function middleware(request: NextRequest) {
  const pathname = request.nextUrl.pathname;

  // Exclude static files, api routes, etc.
  if (
    pathname.startsWith('/_next') ||
    pathname.startsWith('/api') ||
    pathname.startsWith('/favicon') ||
    pathname.includes('.')
  ) {
    return NextResponse.next();
  }

  const sessionCookie = request.cookies.get('session')?.value;
  let sessionPayload = null;
  
  if (sessionCookie) {
    try {
      sessionPayload = await decrypt(sessionCookie);
    } catch (e) {
      // invalid or expired
    }
  }

  // Check if it's an auth route, considering locale prefix
  const isAuthRoute = pathname.startsWith('/auth') || pathname.match(/^\/(en|es)\/auth/);
  const isLoginPage = pathname === '/auth/login' || pathname.match(/^\/(en|es)\/auth\/login/);

  if (!isAuthRoute && !sessionPayload) {
    // Redirect to login. The intlMiddleware will redirect /auth/login to /en/auth/login if needed
    return NextResponse.redirect(new URL('/auth/login', request.url));
  }

  if (isAuthRoute && sessionPayload && isLoginPage) {
    return NextResponse.redirect(new URL('/', request.url));
  }

  // Delegate to next-intl middleware for locale routing
  return intlMiddleware(request);
}

export const config = {
  matcher: [
    // Match all pathnames except for
    // - … if they start with `/api`, `/_next` or `/_vercel`
    // - … the ones containing a dot (e.g. `favicon.ico`)
    '/((?!api|_next|_vercel|.*\\..*).*)'
  ]
};
