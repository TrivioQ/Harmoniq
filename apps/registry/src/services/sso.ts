// Copyright The Harmoniq Authors
// SPDX-License-Identifier: Apache-2.0

import type { FastifyInstance } from 'fastify';
import type { Role } from '@prisma/client';
import {
  IdentityError,
  type IdentityUserInfo,
  type RedirectIdentityProvider,
} from '@harmoniq/core/dist/ports/IdentityProvider';
import { ForbiddenError } from '@harmoniq/core/dist/errors/AppError';
import { OidcConfig } from '@harmoniq/core/dist/schemas/SsoSchema';
import { OidcIdentityProvider } from '../adapters/identity/OidcIdentityProvider';
import { GitHubIdentityProvider } from '../adapters/identity/GitHubIdentityProvider';
import { checkPublicUrl, createSafeFetch, guardedHttpsAgent } from './outbound';
import { SamlService } from './saml';
import { openSecret } from './crypto';
import { audit } from './audit';
import { isDeprovisioned } from './scim';
import { SsoProtocol, SsoSubject, parseSsoProviderId, ssoProviderId } from './ssoIds';

/**
 * What `WorkspaceConfig.oidcConfig` (or `Organization.oidcConfig`) holds: the config with
 * the secret sealed. Organizations have no role mapping (ORG-07 rules instead).
 */
export type StoredOidcConfig = Omit<
  OidcConfig,
  'clientSecret' | 'forceSso' | 'roleMapping' | 'defaultRole'
> &
  Partial<Pick<OidcConfig, 'roleMapping' | 'defaultRole'>> & {
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

/** INST-13: the instance admin turned this protocol off. */
export const disabledProtocol = (protocol: SsoProtocol) =>
  new ForbiddenError(
    `${protocol === 'oidc' ? 'OpenID Connect' : 'SAML'} sign-in is disabled on this instance`
  );

export const workspaceProviderId = (slug: string) =>
  ssoProviderId('oidc', { kind: 'workspace', slug });

/**
 * Redirect providers by id: GitHub, the instance OIDC (`oidc`), workspace OIDC/SAML
 * (`oidc:<workspace>`, `saml:<workspace>`) and organization OIDC/SAML (`org-oidc:<org>`,
 * `org-saml:<org>`, ORG-05) loaded from their config; OIDC is cached a few minutes.
 */
export class SsoProviders {
  private cache = new Map<string, { provider: OidcIdentityProvider | null; expires: number }>();

  private fixedProviders = new Map<string, RedirectIdentityProvider>();
  private fixedRevision = -1;

  constructor(private app: FastifyInstance) {
    this.samlService = new SamlService(app);
  }

  /**
   * GitHub and the instance OIDC, rebuilt when the instance settings change (INST-13:
   * GitHub credentials and every protocol can be turned off by the instance admin).
   */
  private get fixed() {
    const { settings } = this.app.container;
    if (this.fixedRevision === settings.revision) return this.fixedProviders;
    const fixed = new Map<string, RedirectIdentityProvider>();
    const auth = settings.auth();
    const { oidc } = this.app.config;
    if (auth.github) {
      fixed.set(
        'github',
        new GitHubIdentityProvider(auth.github.clientId, auth.github.clientSecret)
      );
    }
    if (oidc && auth.instanceOidc) {
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
    this.fixedProviders = fixed;
    this.fixedRevision = settings.revision;
    return fixed;
  }

  /** INST-13: whether workspaces and organizations may use this protocol. */
  protocolEnabled(protocol: SsoProtocol) {
    return this.app.container.settings.auth()[protocol];
  }

  list() {
    return [...this.fixed.values()];
  }

  /** Forget a subject's OIDC provider after its config changed. */
  invalidate(subject: SsoSubject) {
    this.cache.delete(ssoProviderId('oidc', subject));
  }

  async get(id: string): Promise<RedirectIdentityProvider | null> {
    const fixed = this.fixed.get(id);
    if (fixed) return fixed;
    const parsed = parseSsoProviderId(id);
    if (!parsed || !this.protocolEnabled(parsed.protocol)) return null;
    const { protocol, subject } = parsed;
    if (protocol === 'saml') {
      return (await this.samlService.load(subject)) ? this.samlService.provider(subject) : null;
    }
    const hit = this.cache.get(id);
    if (hit && hit.expires > Date.now()) return hit.provider;

    const loaded = await this.loadOidc(subject);
    this.cache.set(id, { provider: loaded?.provider ?? null, expires: Date.now() + CACHE_MS });
    return loaded?.provider ?? null;
  }

  /** A workspace's or organization's OIDC config (secret decrypted) and provider, or null. */
  async loadOidc(subject: SsoSubject) {
    const { systemDb } = this.app.container;
    const stored = (
      subject.kind === 'workspace'
        ? (
            await systemDb.workspaceConfig.findFirst({
              where: { workspace: { slug: subject.slug } },
            })
          )?.oidcConfig
        : (
            await systemDb.organization.findFirst({
              where: { slug: subject.slug, deletedAt: null },
            })
          )?.oidcConfig
    ) as StoredOidcConfig | null | undefined;
    if (!stored) return null;
    const config = {
      ...stored,
      clientSecret: openSecret(stored.clientSecret, this.app.config.encryptionKey),
      // DOM-01..04: only domains this workspace or organization may rely on.
      trustedDomains: await this.app.container.domains.usableTrustedDomains(
        subject,
        stored.trustedDomains ?? []
      ),
    };
    return { config, provider: this.build(subject, config) };
  }

  build(subject: SsoSubject, config: StoredOidcConfig) {
    const allowPrivate = this.app.config.ssoAllowPrivateIssuers;
    return new OidcIdentityProvider({
      id: ssoProviderId('oidc', subject),
      displayName: 'Single sign-on',
      issuer: config.issuer,
      clientId: config.clientId,
      clientSecret: config.clientSecret,
      scopes: config.scopes,
      groupsClaim: config.groupsClaim,
      trustedDomains: config.trustedDomains,
      // A workspace or org admin chooses this URL: refuse internal targets unless allowed.
      checkUrl: allowPrivate ? undefined : (url) => checkPublicUrl(url, { allowHttp: false }),
      // Every connection is re-checked too, so the issuer can't re-resolve internally.
      ...(!allowPrivate && {
        fetch: createSafeFetch({ allowHttp: false }),
        jwksAgent: guardedHttpsAgent(),
      }),
    });
  }

  /** The workspace or organization and its SSO policy behind a provider id, else null. */
  async policyFor(id: string): Promise<{ subject: SsoSubject; policy: SsoPolicy } | null> {
    const parsed = parseSsoProviderId(id);
    if (!parsed) return null;
    const { protocol, subject } = parsed;
    const loaded =
      protocol === 'oidc' ? await this.loadOidc(subject) : await this.samlService.load(subject);
    if (!loaded) return null;
    const { roleMapping = {}, trustedDomains, defaultRole = 'viewer' } = loaded.config;
    return { subject, policy: { roleMapping, trustedDomains, defaultRole } };
  }

  /** SAML (SSO-09..20, ORG-06) for `saml:<workspace>` and `org-saml:<org>`. */
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
