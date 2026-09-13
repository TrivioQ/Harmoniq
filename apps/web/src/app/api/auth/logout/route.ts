import { NextResponse } from 'next/server';
import { clearSession } from '@/lib/auth';

export async function POST(request: Request) {
  await clearSession();
  return NextResponse.redirect(new URL('/auth/login', request.url));
}

// Support GET for simplicity in some scenarios (though POST is better for CSRF)
export async function GET(request: Request) {
  await clearSession();
  return NextResponse.redirect(new URL('/auth/login', request.url));
}
