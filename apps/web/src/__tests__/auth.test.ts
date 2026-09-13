import { describe, it, expect, vi, beforeEach } from 'vitest';
import { GET } from '../app/api/auth/login/github/route';

describe('Auth Routes', () => {
  beforeEach(() => {
    vi.resetModules();
    process.env.GITHUB_CLIENT_ID = 'mock_client_id';
    process.env.NEXT_PUBLIC_APP_URL = 'http://localhost:3000';
  });

  it('redirects to github auth or mock callback', async () => {
    const response = await GET();

    expect(response.status).toBe(307); // Temporary Redirect
    const redirectUrl = response.headers.get('Location');

    // In mock mode, it redirects straight to callback
    expect(redirectUrl).toContain('/api/auth/callback/github?code=mock_code');
  });
});
