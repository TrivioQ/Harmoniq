import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { decrypt } from './lib/auth';

export async function middleware(request: NextRequest) {
  // If not auth route, protect it
  const isAuthRoute = request.nextUrl.pathname.startsWith('/auth');
  
  // Exclude static files, api routes, etc.
  if (
    request.nextUrl.pathname.startsWith('/_next') ||
    request.nextUrl.pathname.startsWith('/favicon')
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

  if (!isAuthRoute && !sessionPayload) {
    return NextResponse.redirect(new URL('/auth/login', request.url));
  }

  if (isAuthRoute && sessionPayload && request.nextUrl.pathname === '/auth/login') {
    return NextResponse.redirect(new URL('/', request.url));
  }

  return NextResponse.next();
}

export const config = {
  matcher: [
    '/((?!api|_next/static|_next/image|favicon.ico).*)',
  ],
};
