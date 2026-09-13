import { NextRequest, NextResponse } from 'next/server';
import { createSession } from '@/lib/auth';
import { PrismaClient } from '@harmoniq/db';

const db = new PrismaClient();

export async function GET(request: NextRequest) {
  const searchParams = request.nextUrl.searchParams;
  const code = searchParams.get('code');
  
  if (!code) {
    return NextResponse.redirect(new URL('/auth/login?error=missing_code', request.url));
  }

  try {
    let email = '';
    let githubId = '';
    
    // Mock logic for development
    if (code === 'mock_code') {
      email = 'admin@acme.corp';
      githubId = 'mock_github_id';
    } else {
      // Real GitHub OAuth exchange would go here
      // const tokenResponse = await fetch(...)
      // const userResponse = await fetch(...)
      email = 'realuser@example.com'; 
      githubId = 'real_github_id';
    }

    // Upsert user in database
    const user = await db.user.upsert({
      where: { email },
      update: {},
      create: {
        email,
        name: email.split('@')[0],
      }
    });

    // Create session cookie
    await createSession(user.id, user.email);

    return NextResponse.redirect(new URL('/', request.url));
  } catch (error) {
    console.error('OAuth Callback Error:', error);
    return NextResponse.redirect(new URL('/auth/login?error=callback_failed', request.url));
  }
}
