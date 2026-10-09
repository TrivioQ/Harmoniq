import {
  IdentityError,
  IdentityUserInfo,
  RedirectIdentityProvider,
} from '@harmoniq/core/dist/ports/IdentityProvider';

const AUTHORIZE_URL = 'https://github.com/login/oauth/authorize';
const TOKEN_URL = 'https://github.com/login/oauth/access_token';
const API_URL = 'https://api.github.com';

interface GitHubUser {
  id: number;
  login: string;
  name: string | null;
  avatar_url: string | null;
}

interface GitHubEmail {
  email: string;
  primary: boolean;
  verified: boolean;
}

export class GitHubIdentityProvider implements RedirectIdentityProvider {
  readonly kind = 'redirect';
  readonly id = 'github';
  readonly displayName = 'GitHub';

  constructor(
    private clientId: string,
    private clientSecret: string
  ) {}

  getAuthorizationUrl({
    state,
    codeChallenge,
    redirectUri,
  }: {
    state: string;
    codeChallenge: string;
    redirectUri: string;
  }): string {
    const url = new URL(AUTHORIZE_URL);
    url.search = new URLSearchParams({
      client_id: this.clientId,
      redirect_uri: redirectUri,
      state,
      scope: 'read:user user:email',
      code_challenge: codeChallenge,
      code_challenge_method: 'S256',
      allow_signup: 'true',
    }).toString();
    return url.toString();
  }

  async handleCallback({
    code,
    codeVerifier,
    redirectUri,
  }: {
    code: string;
    codeVerifier: string;
    redirectUri: string;
  }): Promise<IdentityUserInfo> {
    const tokenRes = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_id: this.clientId,
        client_secret: this.clientSecret,
        code,
        redirect_uri: redirectUri,
        code_verifier: codeVerifier,
      }),
    });
    if (!tokenRes.ok) {
      throw new IdentityError(
        'provider_unavailable',
        `GitHub token exchange failed (${tokenRes.status})`
      );
    }
    const token = (await tokenRes.json()) as { access_token?: string; error?: string };
    if (!token.access_token) {
      throw new IdentityError(
        'invalid_grant',
        `GitHub rejected the code: ${token.error ?? 'unknown'}`
      );
    }

    const [user, emails] = await Promise.all([
      this.api<GitHubUser>('/user', token.access_token),
      this.api<GitHubEmail[]>('/user/emails', token.access_token),
    ]);

    // The profile email is user-editable and unverified; only the verified primary counts.
    const primary = emails.find((e) => e.primary && e.verified);
    if (!primary) {
      throw new IdentityError(
        'email_not_verified',
        'Your GitHub account has no verified primary email address'
      );
    }

    return {
      providerUserId: String(user.id),
      email: primary.email,
      emailVerified: true,
      name: user.name ?? user.login,
      avatarUrl: user.avatar_url ?? undefined,
    };
  }

  private async api<T>(path: string, accessToken: string): Promise<T> {
    const res = await fetch(`${API_URL}${path}`, {
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${accessToken}`,
        'User-Agent': 'harmoniq',
      },
    });
    if (!res.ok) {
      throw new IdentityError('provider_unavailable', `GitHub API ${path} failed (${res.status})`);
    }
    return (await res.json()) as T;
  }
}
