import { NextResponse } from 'next/server';

export async function GET() {
  const clientId = process.env.GITHUB_CLIENT_ID || 'mock_client_id';
  // Mock redirect for dev without real OAuth keys
  if (clientId === 'mock_client_id') {
    return NextResponse.redirect(
      new URL(
        '/api/auth/callback/github?code=mock_code',
        process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000'
      )
    );
  }

  const redirectUri = `${process.env.NEXT_PUBLIC_APP_URL}/api/auth/callback/github`;
  const url = `https://github.com/login/oauth/authorize?client_id=${clientId}&redirect_uri=${redirectUri}&scope=user:email`;

  return NextResponse.redirect(url);
}
