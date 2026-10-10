// Copyright The Harmoniq Authors
// SPDX-License-Identifier: Apache-2.0

import { createHash } from 'crypto';
import { createRemoteJWKSet, jwtVerify, JWTPayload } from 'jose';
import {
  IdentityError,
  IdentityUserInfo,
  RedirectIdentityProvider,
} from '@harmoniq/core/dist/ports/IdentityProvider';

interface Discovery {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
  userinfo_endpoint?: string;
}

export interface OidcProviderOptions {
  id: string;
  displayName: string;
  issuer: string;
  clientId: string;
  clientSecret: string;
  scopes: string[];
  groupsClaim: string;
  /** Domains whose emails the IdP vouches for even without `email_verified` (Entra). */
  trustedDomains?: string[];
  /** Checks a URL before the registry calls it (SSRF guard); returns an error or null. */
  checkUrl?: (url: string) => Promise<string | null>;
  /** Discovery cache lifetime (SSO-04). */
  discoveryTtlMs?: number;
  fetch?: typeof fetch;
  /** Agent for the JWKS download (jose uses Node's https), e.g. with a guarded lookup. */
  jwksAgent?: import('https').Agent;
}

/**
 * The nonce is derived from the PKCE challenge, which the callback recomputes from the
 * verifier only the browser that started the login holds: an ID token issued for another
 * login is refused, and nothing is stored server-side. (Nonces aren't secret.)
 */
export const nonceFor = (codeChallenge: string) =>
  createHash('sha256').update(`harmoniq-oidc-nonce:${codeChallenge}`).digest('base64url');

const challengeOf = (codeVerifier: string) =>
  createHash('sha256').update(codeVerifier).digest('base64url');

/** SSO-01..05: OIDC Authorization Code + PKCE, ID tokens validated with `jose`. */
export class OidcIdentityProvider implements RedirectIdentityProvider {
  readonly kind = 'redirect' as const;
  readonly id: string;
  readonly displayName: string;
  private discovery: { value: Discovery; expires: number } | null = null;
  private jwks: ReturnType<typeof createRemoteJWKSet> | null = null;
  private readonly doFetch: typeof fetch;

  constructor(private readonly options: OidcProviderOptions) {
    this.id = options.id;
    this.displayName = options.displayName;
    this.doFetch = options.fetch ?? fetch;
  }

  private async guarded(url: string) {
    const problem = await this.options.checkUrl?.(url);
    if (problem) throw new IdentityError('provider_unavailable', `IdP URL refused: ${problem}`);
  }

  /** SSO-04: `/.well-known/openid-configuration`, cached. */
  async metadata(): Promise<Discovery> {
    if (this.discovery && this.discovery.expires > Date.now()) return this.discovery.value;
    const issuer = this.options.issuer.replace(/\/$/, '');
    const url = `${issuer}/.well-known/openid-configuration`;
    await this.guarded(url);
    let value: Discovery;
    try {
      const res = await this.doFetch(url, { signal: AbortSignal.timeout(5_000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      value = (await res.json()) as Discovery;
    } catch (err) {
      throw new IdentityError(
        'provider_unavailable',
        `OIDC discovery failed: ${(err as Error).message}`
      );
    }
    if (value.issuer?.replace(/\/$/, '') !== issuer) {
      throw new IdentityError('provider_unavailable', 'OIDC discovery issuer does not match');
    }
    for (const endpoint of [value.token_endpoint, value.jwks_uri, value.userinfo_endpoint]) {
      if (endpoint) await this.guarded(endpoint);
    }
    this.discovery = { value, expires: Date.now() + (this.options.discoveryTtlMs ?? 3_600_000) };
    this.jwks = createRemoteJWKSet(new URL(value.jwks_uri), {
      ...(this.options.jwksAgent && { agent: this.options.jwksAgent }),
    });
    return value;
  }

  async getAuthorizationUrl(params: { state: string; codeChallenge: string; redirectUri: string }) {
    const meta = await this.metadata();
    const url = new URL(meta.authorization_endpoint);
    url.search = new URLSearchParams({
      response_type: 'code',
      client_id: this.options.clientId,
      redirect_uri: params.redirectUri,
      scope: this.options.scopes.join(' '),
      state: params.state,
      code_challenge: params.codeChallenge,
      code_challenge_method: 'S256',
      nonce: nonceFor(params.codeChallenge),
    }).toString();
    return url.toString();
  }

  private async token(body: Record<string, string>) {
    const meta = await this.metadata();
    const res = await this.doFetch(meta.token_endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
        Authorization: `Basic ${Buffer.from(
          `${encodeURIComponent(this.options.clientId)}:${encodeURIComponent(this.options.clientSecret)}`
        ).toString('base64')}`,
      },
      body: new URLSearchParams(body),
      signal: AbortSignal.timeout(10_000),
    });
    const json = (await res.json().catch(() => ({}))) as Record<string, string>;
    if (!res.ok) {
      throw new IdentityError(
        'invalid_grant',
        json.error_description ?? json.error ?? `HTTP ${res.status}`
      );
    }
    return json;
  }

  async handleCallback(params: {
    code: string;
    codeVerifier: string;
    redirectUri: string;
  }): Promise<IdentityUserInfo> {
    const tokens = await this.token({
      grant_type: 'authorization_code',
      code: params.code,
      redirect_uri: params.redirectUri,
      code_verifier: params.codeVerifier,
    });
    if (!tokens.id_token) throw new IdentityError('invalid_token', 'The IdP returned no ID token');

    const meta = await this.metadata();
    let claims: JWTPayload;
    try {
      // SSO-05: signature (JWKS), iss, aud, exp; iat and nonce below.
      ({ payload: claims } = await jwtVerify(tokens.id_token, this.jwks!, {
        issuer: meta.issuer,
        audience: this.options.clientId,
        maxTokenAge: '10 minutes',
      }));
    } catch (err) {
      throw new IdentityError('invalid_token', `Invalid ID token: ${(err as Error).message}`);
    }
    if (claims.nonce !== nonceFor(challengeOf(params.codeVerifier))) {
      throw new IdentityError('invalid_token', 'ID token nonce does not match this login');
    }

    // Some IdPs keep email or groups out of the ID token: ask userinfo.
    let profile: Record<string, unknown> = claims;
    if (
      (!claims.email || claims[this.options.groupsClaim] === undefined) &&
      meta.userinfo_endpoint
    ) {
      const res = await this.doFetch(meta.userinfo_endpoint, {
        headers: { Authorization: `Bearer ${tokens.access_token}` },
        signal: AbortSignal.timeout(5_000),
      });
      if (res.ok) {
        const info = (await res.json()) as Record<string, unknown>;
        if (info.sub === claims.sub) profile = { ...info, ...claims };
      }
    }

    const email = typeof profile.email === 'string' ? profile.email.toLowerCase() : null;
    if (!email || !claims.sub) throw new IdentityError('invalid_token', 'The IdP sent no email');
    const domain = email.split('@')[1];
    const groups = profile[this.options.groupsClaim];
    return {
      providerUserId: claims.sub,
      email,
      emailVerified:
        profile.email_verified === true ||
        profile.email_verified === 'true' ||
        !!this.options.trustedDomains?.includes(domain),
      name: typeof profile.name === 'string' ? profile.name : undefined,
      avatarUrl: typeof profile.picture === 'string' ? profile.picture : undefined,
      groups: Array.isArray(groups)
        ? groups.map(String)
        : typeof groups === 'string'
          ? [groups]
          : [],
      refreshToken: tokens.refresh_token,
    };
  }

  /** SSO-08/27: a refresh grant; the IdP refusing it ends our session too. */
  async refreshSession(refreshToken: string) {
    const tokens = await this.token({ grant_type: 'refresh_token', refresh_token: refreshToken });
    return { refreshToken: tokens.refresh_token ?? refreshToken };
  }
}
