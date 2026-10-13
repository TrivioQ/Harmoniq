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
  /** SES-02: the session (refresh-token family), so it can be ended at once. */
  sessionId?: string;
  /** SES-03: the session passed a second factor (`amr: ["mfa"]`). */
  mfa?: boolean;
  /** INST-32: when the user last proved who they are (epoch ms; `rat`, in seconds). */
  reauthAt?: number;
}

function key(secret: string): Uint8Array {
  return new TextEncoder().encode(secret);
}

export async function signAccessToken(claims: AccessTokenClaims, secret: string): Promise<string> {
  return new SignJWT({
    email: claims.email,
    ...(claims.provider && { prv: claims.provider }),
    ...(claims.sessionId && { sid: claims.sessionId }),
    ...(claims.mfa && { amr: ['mfa'] }),
    ...(claims.reauthAt && { rat: Math.floor(claims.reauthAt / 1000) }),
  })
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
    ...(typeof payload.sid === 'string' && { sessionId: payload.sid }),
    ...(Array.isArray(payload.amr) && payload.amr.includes('mfa') && { mfa: true }),
    ...(typeof payload.rat === 'number' && { reauthAt: payload.rat * 1000 }),
  };
}

// ─── SES-03: the second step of a sign-in ───────────────────────────────────

const MFA_AUDIENCE = 'harmoniq-mfa';
export const MFA_CHALLENGE_SECONDS = 5 * 60;

/** Proof that the first factor passed, for `POST /api/auth/mfa/verify` (5 minutes). */
export async function signMfaChallenge(
  claims: { userId: string; provider: string; ssoRefreshToken?: string },
  secret: string
) {
  return new SignJWT({
    prv: claims.provider,
    ...(claims.ssoRefreshToken && { srt: claims.ssoRefreshToken }),
  })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(claims.userId)
    .setAudience(MFA_AUDIENCE)
    .setIssuedAt()
    .setExpirationTime(`${MFA_CHALLENGE_SECONDS}s`)
    .sign(key(secret));
}

export async function verifyMfaChallenge(token: string, secret: string) {
  const { payload } = await jwtVerify(token, key(secret), {
    algorithms: ['HS256'],
    audience: MFA_AUDIENCE,
  });
  if (typeof payload.sub !== 'string' || typeof payload.prv !== 'string') {
    throw new Error('Malformed challenge');
  }
  return {
    userId: payload.sub,
    provider: payload.prv,
    ...(typeof payload.srt === 'string' && { ssoRefreshToken: payload.srt }),
  };
}
