import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { createHash, randomBytes, randomUUID } from 'crypto';
import { FastifyInstance } from 'fastify';
import { setupServer } from 'msw/node';
import { http, HttpResponse } from 'msw';
import { buildApp } from '../app';
import { Fixtures, bearer } from './helpers/fixtures';

const WEB_ORIGIN = 'http://localhost:3000';
const REDIRECT_URI = `${WEB_ORIGIN}/api/auth/callback/github`;

// A fake GitHub. Each test sets who "logs in" by choosing the code.
interface FakeGitHubUser {
  id: number;
  emails: { email: string; primary: boolean; verified: boolean }[];
}
const githubUsers = new Map<string, FakeGitHubUser>();
const github = setupServer(
  http.post('https://github.com/login/oauth/access_token', async ({ request }) => {
    const body = (await request.json()) as { code: string };
    return githubUsers.has(body.code)
      ? HttpResponse.json({ access_token: `token-${body.code}` })
      : HttpResponse.json({ error: 'bad_verification_code' });
  }),
  http.get('https://api.github.com/user', ({ request }) => {
    const code = request.headers.get('authorization')!.replace('Bearer token-', '');
    const u = githubUsers.get(code)!;
    return HttpResponse.json({ id: u.id, login: `gh${u.id}`, name: null, avatar_url: null });
  }),
  http.get('https://api.github.com/user/emails', ({ request }) => {
    const code = request.headers.get('authorization')!.replace('Bearer token-', '');
    return HttpResponse.json(githubUsers.get(code)!.emails);
  })
);

describe('Authentication', () => {
  let app: FastifyInstance;
  let fx: Fixtures;
  const run = randomUUID().slice(0, 8);
  const emailFor = (name: string) => `${name}-${run}@example.com`;
  const createdEmails: string[] = [];

  const githubLogin = async (user: FakeGitHubUser) => {
    const code = randomUUID();
    githubUsers.set(code, user);
    user.emails.forEach((e) => createdEmails.push(e.email.toLowerCase()));
    return app.inject({
      method: 'POST',
      url: '/api/auth/github/callback',
      payload: {
        code,
        codeVerifier: randomBytes(32).toString('base64url'),
        redirectUri: REDIRECT_URI,
      },
    });
  };

  beforeAll(async () => {
    process.env.GITHUB_CLIENT_ID = 'test-client';
    process.env.GITHUB_CLIENT_SECRET = 'test-secret';
    process.env.HARMONIQ_DEV_LOGIN = '1';
    process.env.WEB_ORIGIN = WEB_ORIGIN;
    github.listen({ onUnhandledRequest: 'bypass' });
    app = await buildApp();
    await app.ready();
    fx = new Fixtures(app);
  });

  afterEach(() => githubUsers.clear());

  afterAll(async () => {
    github.close();
    await app.container.systemDb.user.deleteMany({ where: { email: { in: createdEmails } } });
    await fx.cleanup();
    await app.close();
  });

  it('lists configured providers', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/auth/providers' });
    expect(res.json().providers.map((p: { id: string }) => p.id)).toEqual([
      'github',
      'email',
      'dev',
    ]);
  });

  describe('GitHub start', () => {
    const verifier = randomBytes(32).toString('base64url');
    const challenge = createHash('sha256').update(verifier).digest('base64url');

    it('returns an authorization URL with state and PKCE challenge', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/auth/github/start',
        payload: {
          state: 'state-1234567890abcdef',
          codeChallenge: challenge,
          redirectUri: REDIRECT_URI,
        },
      });
      expect(res.statusCode).toBe(200);
      const url = new URL(res.json().authorizationUrl);
      expect(url.origin).toBe('https://github.com');
      expect(url.searchParams.get('state')).toBe('state-1234567890abcdef');
      expect(url.searchParams.get('code_challenge')).toBe(challenge);
      expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    });

    it('refuses redirect URIs outside the dashboard origin', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/auth/github/start',
        payload: {
          state: 'state-1234567890abcdef',
          codeChallenge: challenge,
          redirectUri: 'https://evil.example.com/callback',
        },
      });
      expect(res.statusCode).toBe(400);
    });
  });

  describe('GitHub callback', () => {
    it('creates a user, issues a session and links later logins to the same user', async () => {
      const email = emailFor('Alice');
      const gh = {
        id: 1000 + Math.floor(Math.random() * 1e6),
        emails: [{ email, primary: true, verified: true }],
      };

      const first = await githubLogin(gh);
      expect(first.statusCode).toBe(200);
      const session = first.json();
      expect(session.user.email).toBe(email.toLowerCase());
      expect(session.accessToken).toBeTruthy();
      expect(session.refreshToken).toBeTruthy();

      const second = await githubLogin(gh);
      expect(second.json().user.id).toBe(session.user.id);

      const me = await app.inject({
        method: 'GET',
        url: '/api/me',
        headers: bearer(session.accessToken),
      });
      expect(me.statusCode).toBe(200);
      expect(me.json().user.email).toBe(email.toLowerCase());
    });

    it('rejects accounts without a verified primary email and creates nothing', async () => {
      const email = emailFor('unverified');
      const res = await githubLogin({
        id: 2000 + Math.floor(Math.random() * 1e6),
        emails: [
          { email, primary: true, verified: false },
          { email: emailFor('secondary'), primary: false, verified: true },
        ],
      });
      expect(res.statusCode).toBe(401);
      expect(res.json().error.code).toBe('EMAIL_NOT_VERIFIED');
      expect(await app.container.systemDb.user.findFirst({ where: { email } })).toBeNull();
    });

    it('rejects codes GitHub does not accept', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/auth/github/callback',
        payload: {
          code: 'nope',
          codeVerifier: randomBytes(32).toString('base64url'),
          redirectUri: REDIRECT_URI,
        },
      });
      expect(res.statusCode).toBe(401);
    });

    it('links to an existing user with the same verified email and accepts invites', async () => {
      const invited = await fx.user();
      const { workspace } = await fx.workspace();
      await fx.member(workspace.id, invited.id, 'developer', { joined: false });

      const res = await githubLogin({
        id: 3000 + Math.floor(Math.random() * 1e6),
        emails: [{ email: invited.email.toUpperCase(), primary: true, verified: true }],
      });
      expect(res.json().user.id).toBe(invited.id);

      const me = await app.inject({
        method: 'GET',
        url: '/api/me',
        headers: bearer(res.json().accessToken),
      });
      expect(me.json().workspaces).toEqual([
        { slug: workspace.slug, name: workspace.name, role: 'developer' },
      ]);
    });
  });

  describe('sessions', () => {
    const devLogin = async () => {
      const email = emailFor(`dev-${randomUUID().slice(0, 4)}`);
      createdEmails.push(email);
      const res = await app.inject({
        method: 'POST',
        url: '/api/auth/dev/login',
        payload: { email },
      });
      expect(res.statusCode).toBe(200);
      return res.json();
    };
    const refresh = (refreshToken: string) =>
      app.inject({ method: 'POST', url: '/api/auth/refresh', payload: { refreshToken } });
    const ageUsedAt = (token: string, ms: number) =>
      app.container.systemDb.refreshToken.update({
        where: { tokenHash: createHash('sha256').update(token).digest('hex') },
        data: { usedAt: new Date(Date.now() - ms) },
      });

    it('rotates refresh tokens', async () => {
      const session = await devLogin();
      const rotated = await refresh(session.refreshToken);
      expect(rotated.statusCode).toBe(200);
      expect(rotated.json().refreshToken).not.toBe(session.refreshToken);
      expect((await refresh(rotated.json().refreshToken)).statusCode).toBe(200);
    });

    it('revokes the whole family when a rotated token is replayed', async () => {
      const session = await devLogin();
      const rotated = (await refresh(session.refreshToken)).json();
      await ageUsedAt(session.refreshToken, 60_000);

      expect((await refresh(session.refreshToken)).statusCode).toBe(401);
      // The legitimate newer token is revoked too: the attacker and victim both re-login.
      expect((await refresh(rotated.refreshToken)).statusCode).toBe(401);
    });

    it('tolerates two tabs refreshing at the same moment', async () => {
      const session = await devLogin();
      const rotated = (await refresh(session.refreshToken)).json();
      expect((await refresh(session.refreshToken)).statusCode).toBe(401);
      expect((await refresh(rotated.refreshToken)).statusCode).toBe(200);
    });

    it('logout revokes the session', async () => {
      const session = await devLogin();
      const logout = await app.inject({
        method: 'POST',
        url: '/api/auth/logout',
        payload: { refreshToken: session.refreshToken },
      });
      expect(logout.statusCode).toBe(204);
      expect((await refresh(session.refreshToken)).statusCode).toBe(401);
    });

    it('/api/me requires a user session', async () => {
      expect((await app.inject({ method: 'GET', url: '/api/me' })).statusCode).toBe(401);
    });
  });
});

describe('Authentication without optional providers', () => {
  it('does not expose dev login unless enabled', async () => {
    delete process.env.HARMONIQ_DEV_LOGIN;
    delete process.env.GITHUB_CLIENT_ID;
    const app = await buildApp();
    await app.ready();
    // Email stays available outside production (console mailer); GitHub and dev are gone.
    const providers = (await app.inject({ method: 'GET', url: '/api/auth/providers' })).json()
      .providers as { id: string }[];
    expect(providers.map((p) => p.id)).toEqual(['email']);
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/dev/login',
      payload: { email: 'x@example.com' },
    });
    expect(res.statusCode).toBe(404);
    await app.close();
  });
});
