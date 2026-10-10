import type { PrismaClient } from '@prisma/client';

/**
 * Whose single sign-on a provider belongs to: a workspace's own (SSO-01..20) or an
 * organization's, inherited by its workspaces (ORG-05).
 */
export interface SsoSubject {
  kind: 'workspace' | 'organization';
  slug: string;
}

export type SsoProtocol = 'oidc' | 'saml';

/** `oidc:<workspace>`, `saml:<workspace>`, `org-oidc:<org>`, `org-saml:<org>`. */
export const ssoProviderId = (protocol: SsoProtocol, subject: SsoSubject) =>
  `${subject.kind === 'organization' ? 'org-' : ''}${protocol}:${subject.slug}`;

export function parseSsoProviderId(
  id: string | undefined | null
): { protocol: SsoProtocol; subject: SsoSubject } | null {
  const match = id ? /^(org-)?(oidc|saml):(.+)$/.exec(id) : null;
  if (!match) return null;
  return {
    protocol: match[2] as SsoProtocol,
    subject: { kind: match[1] ? 'organization' : 'workspace', slug: match[3] },
  };
}

/** Every provider id a subject's sessions can carry (to revoke them). */
export const ssoProviderIds = (subject: SsoSubject) =>
  (['oidc', 'saml'] as const).map((p) => ssoProviderId(p, subject));

export const sameSubject = (a: SsoSubject | null, b: SsoSubject | null) =>
  !!a && !!b && a.kind === b.kind && a.slug === b.slug;

/**
 * ORG-05: whose single sign-on a workspace uses: its own when it has one (it overrides
 * the organization's), else its organization's, else none. `forceSso` comes from the same.
 */
export async function effectiveSso(
  db: PrismaClient,
  workspace: { id: string; slug: string; organizationId: string | null }
): Promise<{ subject: SsoSubject | null; forceSso: boolean }> {
  const own = await db.workspaceConfig.findUnique({
    where: { workspaceId: workspace.id },
    select: { oidcConfig: true, samlConfig: true, forceSso: true },
  });
  if (own?.oidcConfig || own?.samlConfig) {
    return { subject: { kind: 'workspace', slug: workspace.slug }, forceSso: own.forceSso };
  }
  if (workspace.organizationId) {
    const org = await db.organization.findFirst({
      where: { id: workspace.organizationId, deletedAt: null },
      select: { slug: true, oidcConfig: true, samlConfig: true, forceSso: true },
    });
    if (org && (org.oidcConfig || org.samlConfig)) {
      return { subject: { kind: 'organization', slug: org.slug }, forceSso: org.forceSso };
    }
  }
  return { subject: null, forceSso: own?.forceSso ?? false };
}
