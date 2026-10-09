import type { FastifyInstance } from 'fastify';
import type { Role } from '@prisma/client';
import {
  IdentityError,
  type IdentityUserInfo,
  type RedirectIdentityProvider,
} from '@harmoniq/core/dist/ports/IdentityProvider';
import { OidcConfig } from '@harmoniq/core/dist/schemas/SsoSchema';
import { OidcIdentityProvider } from '../adapters/identity/OidcIdentityProvider';
import { GitHubIdentityProvider } from '../adapters/identity/GitHubIdentityProvider';
import { checkPublicUrl } from './bundleValidator';
import { SamlService } from './saml';
import { openSecret } from './crypto';
import { audit } from './audit';
import { isDeprovisioned } from './scim';

/** What `WorkspaceConfig.oidcConfig` holds: the config with the secret sealed. */
export type StoredOidcConfig = Omit<OidcConfig, 'clientSecret' | 'forceSso'> & {
  clientSecret: string;
};

const RANK: Record<Role, number> = { viewer: 0, developer: 1, admin: 2, owner: 3 };
const CACHE_MS = 5 * 60_000;

declare module 'fastify' {
  interface FastifyInstance {
    /** Redirect sign-in providers (GitHub, OIDC), shared by the auth and SSO routes. */
    ssoProviders: SsoProviders;
  }
}

export const workspaceProviderId = (slug: string) => `oidc:${slug}`;

/**
 * Redirect providers by id: GitHub, the instance OIDC (`oidc`), and workspace OIDC
 * (`oidc:<workspace>`) loaded from the workspace's config, cached a few minutes.
 */
export class SsoProviders {
  private cache = new Map<string, { provider: OidcIdentityProvider | null; expires: number }>();

  private fixed = new Map<string, RedirectIdentityProvider>();

  constructor(private app: FastifyInstance) {
    this.samlService = new SamlService(app);
    const { oidc, github } = app.config;
    const fixed = this.fixed;
    if (github) {
      fixed.set('github', new GitHubIdentityProvider(github.clientId, github.clientSecret));
    }
    if (oidc) {
      fixed.set(
        'oidc',
        new OidcIdentityProvider({
          id: 'oidc',
          displayName: oidc.displayName,
          issuer: oidc.issuer,
          clientId: oidc.clientId,
          clientSecret: oidc.clientSecret,
          scopes: ['openid', 'email', 'profile'],
          groupsClaim: 'groups',
        })
      );
    }
  }

  list() {
    return [...this.fixed.values()];
  }

  /** Forget a workspace's provider after its config changed. */
  invalidate(slug: string) {
    this.cache.delete(workspaceProviderId(slug));
  }

  async get(id: string): Promise<RedirectIdentityProvider | null> {
    const fixed = this.fixed.get(id);
    if (fixed) return fixed;
    if (id.startsWith('saml:')) {
      const slug = id.slice('saml:'.length);
      return (await this.samlService.load(slug)) ? this.samlService.provider(slug) : null;
    }
    if (!id.startsWith('oidc:')) return null;
    const hit = this.cache.get(id);
    if (hit && hit.expires > Date.now()) return hit.provider;

    const slug = id.slice('oidc:'.length);
    const loaded = await this.loadWorkspace(slug);
    this.cache.set(id, { provider: loaded?.provider ?? null, expires: Date.now() + CACHE_MS });
    return loaded?.provider ?? null;
  }

  /** A workspace's OIDC config (secret decrypted) and provider, or null. */
  async loadWorkspace(slug: string) {
    const { systemDb } = this.app.container;
    const workspace = await systemDb.workspace.findUnique({
      where: { slug },
      include: { WorkspaceConfig: true },
    });
    const stored = workspace?.WorkspaceConfig?.oidcConfig as StoredOidcConfig | null | undefined;
    if (!workspace || !stored) return null;
    const config = {
      ...stored,
      clientSecret: openSecret(stored.clientSecret, this.app.config.encryptionKey),
    };
    return { workspace, config, provider: this.build(slug, config) };
  }

  build(slug: string, config: StoredOidcConfig) {
    const allowPrivate = this.app.config.ssoAllowPrivateIssuers;
    return new OidcIdentityProvider({
      id: workspaceProviderId(slug),
      displayName: 'Single sign-on',
      issuer: config.issuer,
      clientId: config.clientId,
      clientSecret: config.clientSecret,
      scopes: config.scopes,
      groupsClaim: config.groupsClaim,
      trustedDomains: config.trustedDomains,
      // A workspace admin chooses this URL: refuse internal targets unless allowed.
      checkUrl: allowPrivate ? undefined : (url) => checkPublicUrl(url, { allowHttp: false }),
    });
  }

  /** The workspace and its SSO policy behind a workspace provider id, else null. */
  async policyFor(id: string): Promise<{ slug: string; policy: SsoPolicy } | null> {
    const [kind, slug] = id.split(':');
    if (!slug) return null;
    if (kind === 'oidc') {
      const loaded = await this.loadWorkspace(slug);
      return loaded && { slug, policy: loaded.config };
    }
    if (kind === 'saml') {
      const loaded = await this.samlService.load(slug);
      return loaded ? { slug, policy: loaded.config } : null;
    }
    return null;
  }

  /** SAML (SSO-09..20) for workspace providers `saml:<workspace>`. */
  readonly samlService: SamlService;

  /** SSO-08/27: the IdP's verdict on a session. */
  async checkSession(providerId: string, refreshToken: string): Promise<string | null> {
    const provider = await this.get(providerId);
    if (!provider?.refreshSession) return refreshToken;
    try {
      return (await provider.refreshSession(refreshToken)).refreshToken;
    } catch {
      return null;
    }
  }
}

/**
 * SSO-06/07/21..23/28 after a workspace SSO login: membership from group mapping (most
 * permissive wins) or the trusted-domain default; a mapped role is resynced on every
 * login (owners are never demoted by the IdP); the login is audited in the workspace.
 */
export interface SsoPolicy {
  roleMapping: Record<string, string>;
  trustedDomains: string[];
  defaultRole: string;
}

export async function provisionSsoMember(
  app: FastifyInstance,
  slug: string,
  providerId: string,
  config: SsoPolicy,
  userId: string,
  info: IdentityUserInfo,
  ip?: string
) {
  const { systemDb, withTenant } = app.container;
  const workspace = await systemDb.workspace.findUniqueOrThrow({ where: { slug } });
  const mapped = (info.groups ?? [])
    .map((group) => config.roleMapping[group] as Role | undefined)
    .filter((role): role is Role => !!role)
    .sort((a, b) => RANK[b] - RANK[a])[0];
  const domain = info.email.split('@')[1];
  const trusted = config.trustedDomains.includes(domain);

  return withTenant(workspace.id, async (tx) => {
    if (await isDeprovisioned(tx, workspace.id, userId)) {
      throw new IdentityError('access_denied', 'Your access to this workspace was removed');
    }
    const existing = await tx.workspaceMember.findUnique({
      where: { workspaceId_userId: { workspaceId: workspace.id, userId } },
    });
    let role = existing?.role ?? null;
    let change: 'joined' | 'role_synced' | null = null;
    if (!existing && (mapped || trusted)) {
      role = mapped ?? (config.defaultRole as Role);
      await tx.workspaceMember.create({
        data: { workspaceId: workspace.id, userId, role, joinedAt: new Date() },
      });
      change = 'joined';
    } else if (existing && mapped && existing.role !== mapped && existing.role !== 'owner') {
      role = mapped;
      await tx.workspaceMember.update({
        where: { id: existing.id },
        data: { role, joinedAt: existing.joinedAt ?? new Date() },
      });
      change = 'role_synced';
    }
    await audit(
      tx,
      workspace.id,
      { principal: { type: 'system', id: providerId }, ip },
      {
        action: 'auth.sso_login',
        resourceType: 'user',
        resourceId: userId,
        metadata: {
          email: info.email,
          provider: providerId,
          groups: info.groups ?? [],
          role,
          ...(change && { change }),
        },
      }
    );
    return { role, change };
  });
}
