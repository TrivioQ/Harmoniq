// Copyright The Harmoniq Authors
// SPDX-License-Identifier: Apache-2.0

import { z } from 'zod';

const base64url = z.string().regex(/^[A-Za-z0-9_-]+$/);

export const AuthStartRequestSchema = z.object({
  state: base64url.min(16).max(256),
  /** PKCE S256 challenge: base64url(sha256(verifier)), always 43 chars. */
  codeChallenge: base64url.length(43),
  redirectUri: z.string().url(),
});
export type AuthStartRequest = z.infer<typeof AuthStartRequestSchema>;

export const AuthCallbackRequestSchema = z.object({
  code: z.string().min(1).max(1024),
  codeVerifier: base64url.min(43).max(128),
  redirectUri: z.string().url(),
});
export type AuthCallbackRequest = z.infer<typeof AuthCallbackRequestSchema>;

export const DevLoginRequestSchema = z.object({
  email: z.string().email(),
  name: z.string().max(255).optional(),
});

export const RefreshRequestSchema = z.object({
  refreshToken: z.string().min(1).max(512),
});

export const SessionUserSchema = z.object({
  id: z.string(),
  email: z.string(),
  name: z.string().nullable(),
  avatarUrl: z.string().nullable(),
  isInstanceAdmin: z.boolean(),
});
export type SessionUser = z.infer<typeof SessionUserSchema>;

export const SessionResponseSchema = z.object({
  accessToken: z.string(),
  accessTokenExpiresAt: z.string().datetime(),
  refreshToken: z.string(),
  refreshTokenExpiresAt: z.string().datetime(),
  user: SessionUserSchema,
});
export type SessionResponse = z.infer<typeof SessionResponseSchema>;

/**
 * SES-03: a sign-in by a user with MFA, without SSO, answers with a challenge instead of a
 * session; `POST /api/auth/mfa/verify` with it and a code gives the session.
 */
export const MfaChallengeResponseSchema = z.object({
  mfaRequired: z.literal(true),
  challenge: z.string(),
  expiresAt: z.string().datetime(),
});
export type MfaChallengeResponse = z.infer<typeof MfaChallengeResponseSchema>;
export type SignInResponse = SessionResponse | MfaChallengeResponse;

export const MfaVerifyRequestSchema = z.object({
  challenge: z.string().min(1).max(2000),
  /** A 6-digit code from the authenticator app, or a recovery code. */
  code: z.string().trim().min(6).max(32),
});

/** SES-02: one signed-in session (a refresh-token family). */
export interface SessionSummary {
  id: string;
  provider: string | null;
  createdAt: string;
  lastActiveAt: string;
  expiresAt: string;
  ip: string | null;
  userAgent: string | null;
  mfa: boolean;
  current: boolean;
}

export const AuthProviderSummarySchema = z.object({
  id: z.string(),
  kind: z.enum(['redirect', 'token', 'email', 'dev']),
  displayName: z.string(),
});
export type AuthProviderSummary = z.infer<typeof AuthProviderSummarySchema>;

export const MeResponseSchema = z.object({
  user: SessionUserSchema,
  workspaces: z.array(
    z.object({
      slug: z.string(),
      name: z.string(),
      role: z.enum(['owner', 'admin', 'developer', 'viewer']),
      /** The workspace's organization, if any. */
      organization: z.string().optional(),
      /** INST-09: suspended by the instance admin (read-only). */
      suspended: z.boolean().optional(),
    })
  ),
  organizations: z
    .array(
      z.object({
        slug: z.string(),
        name: z.string(),
        role: z.enum(['org_admin', 'org_member', 'org_billing', 'org_auditor']),
      })
    )
    .default([]),
  /** TLC-02: deleted workspaces you own, restorable until `purgeAfter`. */
  deletedWorkspaces: z
    .array(z.object({ slug: z.string(), name: z.string(), purgeAfter: z.string().nullable() }))
    .default([]),
});
export type MeResponse = z.infer<typeof MeResponseSchema>;

export const EmailLoginRequestSchema = z.object({
  email: z.string().email().max(320),
  redirectUri: z.string().url(),
  /** Random value also stored in a cookie of the requesting browser. */
  nonce: base64url.min(16).max(128),
});

export const EmailLoginVerifySchema = z.union([
  z.object({ token: base64url.min(16).max(256), nonce: base64url.min(16).max(128) }),
  z.object({ email: z.string().email().max(320), code: z.string().regex(/^\d{6}$/) }),
]);
