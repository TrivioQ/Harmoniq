// Copyright The Harmoniq Authors
// SPDX-License-Identifier: Apache-2.0

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
  /** SSO-23: IdP groups (OIDC), for role mapping. */
  groups?: string[];
  /** SSO-08: the IdP's refresh token, to re-check the IdP session while ours lives. */
  refreshToken?: string;
}

interface IdentityProviderBase {
  /** Unique key, e.g. 'github', 'email', 'oidc', 'firebase'. */
  id: string;
  displayName: string;
}

/** Redirect-based providers: GitHub, Google, generic OIDC, SAML. Uses PKCE (S256). */
export interface RedirectIdentityProvider extends IdentityProviderBase {
  kind: 'redirect';
  /** May need the provider's metadata first (OIDC discovery). */
  getAuthorizationUrl(params: {
    state: string;
    codeChallenge: string;
    redirectUri: string;
  }): string | Promise<string>;
  handleCallback(params: {
    code: string;
    codeVerifier: string;
    redirectUri: string;
  }): Promise<IdentityUserInfo>;
  /**
   * SSO-08/27: checks that the IdP session is still valid using its refresh token;
   * returns the (possibly rotated) refresh token, or throws when the IdP refuses.
   */
  refreshSession?(refreshToken: string): Promise<{ refreshToken: string }>;
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
      | 'invalid_grant'
      | 'email_not_verified'
      | 'provider_unavailable'
      | 'invalid_token'
      | 'access_denied'
      /** SES-04 */
      | 'account_suspended'
      /** SES-03: the code didn't match, or the challenge expired. */
      | 'mfa_invalid'
      | 'mfa_expired',
    message: string
  ) {
    super(message);
    this.name = 'IdentityError';
  }
}
