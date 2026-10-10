// Copyright The Harmoniq Authors
// SPDX-License-Identifier: Apache-2.0

import { SignJWT, jwtVerify } from 'jose';

// Shared with apps/web: both verify the same access tokens.
export const SESSION_AUDIENCE = 'harmoniq-session';
export const ACCESS_TOKEN_TTL_SECONDS = 15 * 60;

export interface AccessTokenClaims {
  userId: string;
  email: string;
  /** How the user signed in (`prv`), e.g. 'github' or 'oidc:acme'; for forced SSO. */
  provider?: string;
}

function key(secret: string): Uint8Array {
  return new TextEncoder().encode(secret);
}

export async function signAccessToken(claims: AccessTokenClaims, secret: string): Promise<string> {
  return new SignJWT({ email: claims.email, ...(claims.provider && { prv: claims.provider }) })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(claims.userId)
    .setAudience(SESSION_AUDIENCE)
    .setIssuedAt()
    .setExpirationTime(`${ACCESS_TOKEN_TTL_SECONDS}s`)
    .sign(key(secret));
}

/** Throws on invalid signature, wrong audience, or expiry. */
export async function verifyAccessToken(token: string, secret: string): Promise<AccessTokenClaims> {
  const { payload } = await jwtVerify(token, key(secret), {
    algorithms: ['HS256'],
    audience: SESSION_AUDIENCE,
  });
  if (typeof payload.sub !== 'string' || typeof payload.email !== 'string') {
    throw new Error('Malformed access token');
  }
  return {
    userId: payload.sub,
    email: payload.email,
    ...(typeof payload.prv === 'string' && { provider: payload.prv }),
  };
}
