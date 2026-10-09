import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';
import { POST as requestLink } from '../app/api/auth/email/request/route';
import { POST as verifyLink } from '../app/api/auth/email/verify/route';
import { POST as verifyCode } from '../app/api/auth/email/code/route';

const APP = 'http://localhost:3000';
const REGISTRY = 'http://registry.test';

const session = {
  accessToken: 'a',
  accessTokenExpiresAt: new Date(Date.now() + 900_000).toISOString(),
  refreshToken: 'r',
  refreshTokenExpiresAt: new Date(Date.now() + 86_400_000).toISOString(),
  user: { id: 'u', email: 'a@example.com', name: null, avatarUrl: null, isInstanceAdmin: false },
};

function post(
  path: string,
  fields: Record<string, string>,
  opts: { origin?: string; cookie?: string } = {}
) {
  const headers = new Headers({ 'content-type': 'application/x-www-form-urlencoded' });
  headers.set('origin', opts.origin ?? APP);
  if (opts.cookie) headers.set('cookie', opts.cookie);
  return new NextRequest(new URL(path, APP), {
    method: 'POST',
    headers,
    body: new URLSearchParams(fields).toString(),
  });
}

const cookieValue = (res: Response, name: string) =>
  res.headers
    .getSetCookie()
    .find((c) => c.startsWith(`${name}=`))
    ?.split(';')[0]
    .slice(name.length + 1);

describe('email sign-in routes', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    process.env.NEXT_PUBLIC_APP_URL = APP;
    process.env.REGISTRY_URL = REGISTRY;
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('requests a link bound to this browser by a nonce cookie', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ status: 'sent' }), { status: 202 }));
    const res = await requestLink(post('/api/auth/email/request', { email: 'a@example.com' }));

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(fetchMock.mock.calls[0][0]).toBe(`${REGISTRY}/api/auth/email/request`);
    expect(body).toMatchObject({ email: 'a@example.com', redirectUri: `${APP}/auth/verify` });
    expect(cookieValue(res, 'hq_email_nonce')).toBe(body.nonce);
    expect(res.headers.get('location')).toBe(`${APP}/auth/login?sent=1&email=a%40example.com`);
  });

  it('refuses cross-site submissions', async () => {
    const res = await requestLink(
      post(
        '/api/auth/email/request',
        { email: 'a@example.com' },
        { origin: 'https://evil.example' }
      )
    );
    expect(res.headers.get('location')).toContain('error=invalid_origin');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('completes a link sign-in with the nonce from the cookie', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify(session), { status: 200 }));
    const res = await verifyLink(
      post(
        '/api/auth/email/verify',
        { token: 'tok-1234567890abcdef' },
        { cookie: 'hq_email_nonce=n0nce-from-cookie' }
      )
    );
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({
      token: 'tok-1234567890abcdef',
      nonce: 'n0nce-from-cookie',
    });
    expect(cookieValue(res, 'hq_session')).toBe('a');
  });

  it('explains that the link must be opened in the requesting browser', async () => {
    const res = await verifyLink(post('/api/auth/email/verify', { token: 'tok-1234567890abcdef' }));
    expect(res.headers.get('location')).toContain('error=other_browser');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('keeps the user on the code form after a wrong code', async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ error: { code: 'INVALID_TOKEN' } }), { status: 401 })
    );
    const res = await verifyCode(
      post('/api/auth/email/code', { email: 'a@example.com', code: '123456' })
    );
    expect(res.headers.get('location')).toBe(
      `${APP}/auth/login?sent=1&email=a%40example.com&error=invalid_code`
    );
  });
});
