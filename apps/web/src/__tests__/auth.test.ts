import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createHash } from 'crypto';
import { NextRequest } from 'next/server';
import { SignJWT } from 'jose';
import { GET as login } from '../app/api/auth/login/[provider]/route';
import { GET as callback } from '../app/api/auth/callback/[provider]/route';
import { POST as logout } from '../app/api/auth/logout/route';
import proxy from '../proxy';
import { getJwtKey } from '../lib/env';

const APP = 'http://localhost:3000';
const REGISTRY = 'http://registry.test';

const session = {
  accessToken: 'new-access',
  accessTokenExpiresAt: new Date(Date.now() + 900_000).toISOString(),
  refreshToken: 'new-refresh',
  refreshTokenExpiresAt: new Date(Date.now() + 86_400_000).toISOString(),
  user: { id: 'u1', email: 'a@example.com', name: null, avatarUrl: null, isInstanceAdmin: false },
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

const params = (provider: string) => ({ params: Promise.resolve({ provider }) });

function request(
  url: string,
  init: { cookies?: Record<string, string>; method?: string; origin?: string } = {}
) {
  const headers = new Headers();
  if (init.cookies) {
    headers.set(
      'cookie',
      Object.entries(init.cookies)
        .map(([k, v]) => `${k}=${v}`)
        .join('; ')
    );
  }
  if (init.origin) headers.set('origin', init.origin);
  return new NextRequest(new URL(url, APP), { method: init.method ?? 'GET', headers });
}

const setCookie = (res: Response, name: string) =>
  res.headers
    .getSetCookie()
    .find((c) => c.startsWith(`${name}=`))
    ?.split(';')[0]
    .slice(name.length + 1);

describe('dashboard auth', () => {
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

  describe('login', () => {
    it('starts sign-in with state and a PKCE challenge derived from the stored verifier', async () => {
      fetchMock.mockResolvedValue(
        json({ authorizationUrl: 'https://github.com/login/oauth/authorize?x=1' })
      );

      const res = await login(request('/api/auth/login/github'), params('github'));

      expect(res.status).toBe(307);
      expect(res.headers.get('location')).toBe('https://github.com/login/oauth/authorize?x=1');
      const [url, init] = fetchMock.mock.calls[0];
      expect(url).toBe(`${REGISTRY}/api/auth/github/start`);
      const body = JSON.parse(init.body);
      expect(body.redirectUri).toBe(`${APP}/api/auth/callback/github`);

      const verifier = setCookie(res, 'hq_oauth_verifier')!;
      expect(setCookie(res, 'hq_oauth_state')).toBe(body.state);
      expect(createHash('sha256').update(verifier).digest('base64url')).toBe(body.codeChallenge);
    });

    it('reports an unavailable provider', async () => {
      fetchMock.mockResolvedValue(json({ error: { code: 'NOT_FOUND' } }, 404));
      const res = await login(request('/api/auth/login/nope'), params('nope'));
      expect(res.headers.get('location')).toBe(`${APP}/auth/login?error=provider_unavailable`);
    });
  });

  describe('callback', () => {
    const oauthCookies = { hq_oauth_state: 'state-abc', hq_oauth_verifier: 'verifier-xyz' };

    it('rejects a state that does not match this browser and never calls the registry', async () => {
      const res = await callback(
        request('/api/auth/callback/github?code=c&state=attacker-state', { cookies: oauthCookies }),
        params('github')
      );
      expect(res.headers.get('location')).toBe(`${APP}/auth/login?error=invalid_state`);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('stores the session and clears the OAuth cookies on success', async () => {
      fetchMock.mockResolvedValue(json(session));
      const res = await callback(
        request('/api/auth/callback/github?code=c&state=state-abc', { cookies: oauthCookies }),
        params('github')
      );

      expect(res.headers.get('location')).toBe(`${APP}/`);
      expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toMatchObject({
        code: 'c',
        codeVerifier: 'verifier-xyz',
      });
      expect(setCookie(res, 'hq_session')).toBe('new-access');
      expect(setCookie(res, 'hq_refresh')).toBe('new-refresh');
      expect(setCookie(res, 'hq_oauth_state')).toBe('');
      const sessionCookie = res.headers.getSetCookie().find((c) => c.startsWith('hq_session='))!;
      expect(sessionCookie).toMatch(/HttpOnly/i);
      expect(sessionCookie).toMatch(/SameSite=lax/i);
    });

    it('passes the registry error code through', async () => {
      fetchMock.mockResolvedValue(
        json({ error: { code: 'EMAIL_NOT_VERIFIED', message: 'x' } }, 401)
      );
      const res = await callback(
        request('/api/auth/callback/github?code=c&state=state-abc', { cookies: oauthCookies }),
        params('github')
      );
      expect(res.headers.get('location')).toBe(`${APP}/auth/login?error=email_not_verified`);
    });
  });

  describe('logout', () => {
    it('refuses cross-site requests', async () => {
      const res = await logout(
        request('/api/auth/logout', { method: 'POST', origin: 'https://evil.example' })
      );
      expect(res.status).toBe(403);
    });

    it('revokes the refresh token and clears cookies', async () => {
      fetchMock.mockResolvedValue(new Response(null, { status: 204 }));
      const res = await logout(
        request('/api/auth/logout', { method: 'POST', origin: APP, cookies: { hq_refresh: 'r1' } })
      );
      expect(res.status).toBe(303);
      expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ refreshToken: 'r1' });
      expect(setCookie(res, 'hq_session')).toBe('');
      expect(setCookie(res, 'hq_refresh')).toBe('');
    });
  });

  describe('proxy', () => {
    const accessToken = (expiresIn: string) =>
      new SignJWT({ email: 'a@example.com' })
        .setProtectedHeader({ alg: 'HS256' })
        .setSubject('u1')
        .setAudience('harmoniq-session')
        .setIssuedAt()
        .setExpirationTime(expiresIn)
        .sign(getJwtKey());

    it('lets a valid session through without calling the registry', async () => {
      const res = await proxy(
        request('/en/acme', { cookies: { hq_session: await accessToken('5m') } })
      );
      expect(res.headers.get('location')).toBeNull();
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('refreshes an expired session and forwards the new token', async () => {
      fetchMock.mockResolvedValue(json(session));
      const res = await proxy(
        request('/en/acme', {
          cookies: { hq_session: await accessToken('-1m'), hq_refresh: 'old' },
        })
      );
      expect(fetchMock.mock.calls[0][0]).toBe(`${REGISTRY}/api/auth/refresh`);
      expect(setCookie(res, 'hq_session')).toBe('new-access');
      expect(setCookie(res, 'hq_refresh')).toBe('new-refresh');
      // Downstream rendering must see the refreshed token in this same request: Next
      // forwards overridden request headers as `x-middleware-request-<name>`.
      expect(res.headers.get('x-middleware-request-cookie')).toContain('hq_session=new-access');
    });

    it('sends signed-out users to login without clearing cookies', async () => {
      fetchMock.mockResolvedValue(json({ error: { code: 'UNAUTHORIZED' } }, 401));
      const res = await proxy(request('/en/acme', { cookies: { hq_refresh: 'lost-race' } }));
      expect(res.headers.get('location')).toBe(`${APP}/auth/login`);
      expect(res.headers.getSetCookie()).toEqual([]);
    });

    it('keeps sign-in and first-boot setup public', async () => {
      for (const path of ['/en/auth/login', '/admin/setup', '/es/admin/setup']) {
        const res = await proxy(request(path));
        expect(res.headers.get('location') ?? '').not.toContain('/auth/login');
      }
    });

    it('bounces signed-in users away from the login page', async () => {
      const res = await proxy(
        request('/en/auth/login', { cookies: { hq_session: await accessToken('5m') } })
      );
      expect(res.headers.get('location')).toBe(`${APP}/`);
    });
  });
});
