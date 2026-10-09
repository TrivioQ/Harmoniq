import { z } from 'zod';

const role = z.enum(['viewer', 'developer', 'admin', 'owner']);
const domain = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z0-9-]+(\.[a-z0-9-]+)+$/, 'A domain like acme.com');

/** SSO-01..07, 22, 23, 26: a workspace's OIDC sign-in. */
export const OidcConfigSchema = z.object({
  issuer: z.string().url(),
  clientId: z.string().min(1).max(500),
  /** Write-only; omit on update to keep the stored secret. */
  clientSecret: z.string().min(1).max(2000).optional(),
  scopes: z.array(z.string().min(1)).default(['openid', 'email', 'profile']),
  /** Claim with the user's groups, e.g. `groups` (Okta, Keycloak) or `roles` (Entra). */
  groupsClaim: z.string().min(1).max(100).default('groups'),
  /** SSO-23: IdP group → role; the most permissive match wins. */
  roleMapping: z.record(z.string().min(1), role).default({}),
  /** SSO-22: users with these email domains join automatically. */
  trustedDomains: z.array(domain).max(50).default([]),
  defaultRole: role.exclude(['owner']).default('viewer'),
  /** SSO-26: members must sign in through this IdP (owners are exempt, as break-glass). */
  forceSso: z.boolean().default(false),
});

export type OidcConfig = z.infer<typeof OidcConfigSchema>;
