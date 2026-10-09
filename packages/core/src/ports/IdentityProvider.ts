/**
 * Proves who a user is. Providers never create sessions: the registry links the returned
 * identity to its own `User` and issues Harmoniq sessions, so no provider is on the
 * request path after login. See docs/features/authentication.md.
 */
export interface IdentityUserInfo {
  /** Stable subject at the provider (GitHub user id, Firebase uid, OIDC `sub`). */
  providerUserId: string;
  email: string;
  /** Accounts are only created or linked by email when the provider verified it. */
  emailVerified: boolean;
  name?: string;
  avatarUrl?: string;
}

interface IdentityProviderBase {
  /** Unique key, e.g. 'github', 'email', 'oidc', 'firebase'. */
  id: string;
  displayName: string;
}

/** Redirect-based providers: GitHub, Google, generic OIDC, SAML. Uses PKCE (S256). */
export interface RedirectIdentityProvider extends IdentityProviderBase {
  kind: 'redirect';
  getAuthorizationUrl(params: {
    state: string;
    codeChallenge: string;
    redirectUri: string;
  }): string;
  handleCallback(params: {
    code: string;
    codeVerifier: string;
    redirectUri: string;
  }): Promise<IdentityUserInfo>;
}

/** Client-SDK providers that hand the server a signed token: Firebase, Supabase, Clerk. */
export interface TokenIdentityProvider extends IdentityProviderBase {
  kind: 'token';
  /** Verify signature, issuer, audience and expiry; throw on any failure. */
  verifyToken(idToken: string): Promise<IdentityUserInfo>;
  /** Public config the dashboard needs to initialise the client SDK (no secrets). */
  getClientConfig(): Record<string, string>;
}

/** Built-in passwordless email (magic link / one-time code). */
export interface EmailIdentityProvider extends IdentityProviderBase {
  kind: 'email';
  /** Always resolves (no user enumeration); rate-limited by the caller. */
  requestLogin(params: { email: string; redirectUri: string; nonce: string }): Promise<void>;
  verifyLogin(
    params: { token: string; nonce: string } | { email: string; code: string }
  ): Promise<IdentityUserInfo>;
}

export type IdentityProvider =
  RedirectIdentityProvider | TokenIdentityProvider | EmailIdentityProvider;

/** Thrown by providers when the user could not be authenticated. Safe to show. */
export class IdentityError extends Error {
  constructor(
    public readonly code:
      'invalid_grant' | 'email_not_verified' | 'provider_unavailable' | 'invalid_token',
    message: string
  ) {
    super(message);
    this.name = 'IdentityError';
  }
}
