import { createHash, randomBytes, randomUUID } from 'crypto';
import type { FastifyInstance } from 'fastify';
import { CacheProvider, Profile, SAML, ValidateInResponseTo } from '@node-saml/node-saml';
import { DOMParser } from '@xmldom/xmldom';
import selfsigned from 'selfsigned';
import type { ICache } from '@harmoniq/core/dist/ports/ICache';
import {
  IdentityError,
  IdentityUserInfo,
  RedirectIdentityProvider,
} from '@harmoniq/core/dist/ports/IdentityProvider';
import type { SamlConfig } from '@harmoniq/core/dist/schemas/SsoSchema';
import { openSecret } from './crypto';

/** What `WorkspaceConfig.samlConfig` holds: the config plus the SP keypair (key sealed). */
export type StoredSamlConfig = Omit<SamlConfig, 'forceSso'> & {
  spPrivateKey: string;
  spCert: string;
};

export const samlProviderId = (slug: string) => `saml:${slug}`;

const HANDOFF_TTL_SECONDS = 300;
const START_TTL_SECONDS = 600;
const sha256 = (value: string) => createHash('sha256').update(value).digest('base64url');

/** SSO-10..13: the SP's URLs for a workspace; the entity ID is the metadata URL. */
export function samlUrls(publicUrl: string, slug: string) {
  const base = `${publicUrl}/auth/saml/${encodeURIComponent(slug)}`;
  return {
    entityId: `${base}/metadata`,
    metadata: `${base}/metadata`,
    acs: `${base}/acs`,
    login: `${base}/login`,
    logout: `${base}/logout`,
    slo: `${base}/slo`,
  };
}

/** SSO-18: a per-workspace SP signing keypair (self-signed, 10 years). */
export function generateSpKeyPair(slug: string) {
  const pems = selfsigned.generate([{ name: 'commonName', value: `harmoniq-sp-${slug}` }], {
    days: 3650,
    keySize: 2048,
    algorithm: 'sha256',
  });
  return { privateKey: pems.private, cert: pems.cert };
}

/** PEM or bare base64 → the base64 body node-saml expects. */
export const certBody = (pem: string) =>
  pem.replace(/-----(BEGIN|END) CERTIFICATE-----/g, '').replace(/\s+/g, '');

/** SSO-17: the IdP settings from its metadata XML. */
export function parseIdpMetadata(xml: string) {
  const doc = new DOMParser().parseFromString(xml, 'text/xml');
  const byLocalName = (name: string) => {
    const found: Element[] = [];
    const all = doc.getElementsByTagName('*');
    for (let i = 0; i < all.length; i++) {
      if (all[i].localName === name) found.push(all[i]);
    }
    return found;
  };
  const entity = byLocalName('EntityDescriptor')[0];
  const idp = byLocalName('IDPSSODescriptor')[0];
  if (!entity || !idp) throw new Error('Not IdP metadata (no IDPSSODescriptor)');
  const service = (name: string) => {
    const services = byLocalName(name);
    const preferred =
      services.find((s) => s.getAttribute('Binding')?.endsWith('HTTP-Redirect')) ?? services[0];
    return preferred?.getAttribute('Location') ?? undefined;
  };
  const keys = byLocalName('KeyDescriptor').filter(
    (k) => !k.getAttribute('use') || k.getAttribute('use') === 'signing'
  );
  const certNode = keys
    .flatMap((k) => {
      const nodes = k.getElementsByTagName('*');
      const certs: Element[] = [];
      for (let i = 0; i < nodes.length; i++) {
        if (nodes[i].localName === 'X509Certificate') certs.push(nodes[i]);
      }
      return certs;
    })
    .at(0);
  const idpSsoUrl = service('SingleSignOnService');
  if (!idpSsoUrl || !certNode?.textContent) {
    throw new Error('The metadata has no SingleSignOnService or signing certificate');
  }
  return {
    idpEntityId: entity.getAttribute('entityID') ?? '',
    idpSsoUrl,
    idpSloUrl: service('SingleLogoutService'),
    idpCert: certNode.textContent.replace(/\s+/g, ''),
  };
}

/** node-saml's request-ID cache (InResponseTo checks) on the registry cache. */
class CacheBridge implements CacheProvider {
  constructor(
    private cache: ICache,
    private prefix: string
  ) {}
  async saveAsync(key: string, value: string) {
    await this.cache.set(this.prefix + key, value, START_TTL_SECONDS);
    return { value, createdAt: Date.now() };
  }
  getAsync(key: string) {
    return this.cache.get(this.prefix + key);
  }
  async removeAsync(key: string | null) {
    if (!key) return null;
    const value = await this.cache.get(this.prefix + key);
    await this.cache.del(this.prefix + key);
    return value;
  }
}

interface Handoff {
  info: IdentityUserInfo;
  provider: string;
  codeChallenge: string | null;
}

/**
 * SAML 2.0 for one workspace: SP-initiated sign-in through the dashboard's usual
 * redirect flow (state + PKCE), the ACS validating responses with node-saml, and a
 * one-time hand-off code bound to the PKCE challenge, exchanged by the dashboard.
 */
export class SamlService {
  constructor(private app: FastifyInstance) {}

  private get cache() {
    return this.app.container.cache;
  }

  async load(slug: string) {
    const { systemDb } = this.app.container;
    const workspace = await systemDb.workspace.findUnique({
      where: { slug },
      include: { WorkspaceConfig: true },
    });
    const stored = workspace?.WorkspaceConfig?.samlConfig as StoredSamlConfig | null | undefined;
    if (!workspace || !stored) return null;
    return {
      workspace,
      config: {
        ...stored,
        spPrivateKey: openSecret(stored.spPrivateKey, this.app.config.encryptionKey),
      },
    };
  }

  /** node-saml configured for the workspace (SSO-14: what it validates). */
  saml(slug: string, config: StoredSamlConfig, validateInResponseTo: ValidateInResponseTo) {
    const urls = samlUrls(this.app.config.publicUrl, slug);
    return new SAML({
      entryPoint: config.idpSsoUrl,
      logoutUrl: config.idpSloUrl ?? config.idpSsoUrl,
      issuer: urls.entityId,
      callbackUrl: urls.acs,
      audience: urls.entityId,
      idpCert: certBody(config.idpCert),
      idpIssuer: config.idpEntityId,
      privateKey: config.spPrivateKey,
      publicCert: config.spCert,
      signatureAlgorithm: 'sha256',
      identifierFormat: config.nameIdFormat,
      wantAssertionsSigned: true,
      wantAuthnResponseSigned: false,
      validateInResponseTo,
      requestIdExpirationPeriodMs: START_TTL_SECONDS * 1000,
      cacheProvider: new CacheBridge(this.cache, `saml-id:${slug}:`),
      acceptedClockSkewMs: 60_000,
    });
  }

  /** SSO-16: the user from the assertion, by the workspace's attribute mapping. */
  profileToInfo(profile: Profile, config: StoredSamlConfig): IdentityUserInfo {
    const attr = (name?: string) => {
      const value = name ? profile[name] : undefined;
      return Array.isArray(value)
        ? value.map(String)
        : value === undefined
          ? undefined
          : [String(value)];
    };
    const email = (
      attr(config.attributeMapping.email)?.[0] ??
      profile.email ??
      profile.mail ??
      (profile.nameID?.includes('@') ? profile.nameID : undefined)
    )?.toLowerCase();
    if (!email) throw new IdentityError('invalid_token', 'The SAML assertion has no email');
    return {
      providerUserId: `${profile.issuer}|${profile.nameID}`,
      email,
      // The workspace's IdP vouches for it; sessions from it are scoped to the workspace.
      emailVerified: true,
      name: attr(config.attributeMapping.name)?.[0],
      groups: attr(config.attributeMapping.groups) ?? [],
    };
  }

  async metadata(slug: string) {
    const loaded = await this.load(slug);
    if (!loaded) return null;
    return this.saml(
      slug,
      loaded.config,
      ValidateInResponseTo.never
    ).generateServiceProviderMetadata(null, loaded.config.spCert);
  }

  /** Starts a test login (SSO-20): attributes are shown, no session is created. */
  async testUrl(slug: string) {
    const loaded = await this.load(slug);
    if (!loaded) return null;
    const id = randomUUID();
    const url = await this.saml(
      slug,
      loaded.config,
      ValidateInResponseTo.always
    ).getAuthorizeUrlAsync(`test:${id}`, undefined, {});
    return { id, url };
  }

  testResult(id: string) {
    return this.cache.get(`saml-test:${id}`);
  }

  /**
   * SSO-10/14: validates a posted response and decides where the browser goes next:
   * the dashboard callback with a one-time code (SP- or IdP-initiated) or the settings
   * page with test results.
   */
  async acs(slug: string, body: Record<string, string>): Promise<string> {
    const loaded = await this.load(slug);
    if (!loaded) throw new IdentityError('provider_unavailable', 'SAML is not set up');
    const { config } = loaded;
    const relayState = body.RelayState ?? '';
    const webOrigin = this.app.config.webOrigin;

    const start = relayState ? await this.cache.get(`saml-start:${slug}:${relayState}`) : null;
    const isTest = relayState.startsWith('test:');
    if (!start && !isTest && !config.allowIdpInitiated) {
      throw new IdentityError(
        'invalid_grant',
        'Unsolicited SAML response (IdP-initiated login is off)'
      );
    }
    const saml = this.saml(
      slug,
      config,
      start || isTest ? ValidateInResponseTo.always : ValidateInResponseTo.ifPresent
    );
    let profile: Profile | null;
    try {
      ({ profile } = await saml.validatePostResponseAsync(body));
    } catch (err) {
      throw new IdentityError('invalid_token', `Invalid SAML response: ${(err as Error).message}`);
    }
    if (!profile) throw new IdentityError('invalid_token', 'The SAML response has no assertion');

    if (isTest) {
      const id = relayState.slice('test:'.length);
      const attributes = Object.fromEntries(
        Object.entries(profile).filter(([, v]) => typeof v !== 'function')
      );
      let mapped: IdentityUserInfo | { error: string };
      try {
        mapped = this.profileToInfo(profile, config);
      } catch (err) {
        mapped = { error: (err as Error).message };
      }
      await this.cache.set(`saml-test:${id}`, JSON.stringify({ attributes, mapped }), 600);
      return `${webOrigin}/w/${encodeURIComponent(slug)}/settings/sso?samlTest=${id}`;
    }

    const info = this.profileToInfo(profile, config);
    const code = randomBytes(32).toString('base64url');
    let codeChallenge: string | null = null;
    let target = `${webOrigin}/api/auth/saml/idp?code=${code}&provider=${encodeURIComponent(samlProviderId(slug))}`;
    if (start) {
      const parsed = JSON.parse(start) as { codeChallenge: string; redirectUri: string };
      await this.cache.del(`saml-start:${slug}:${relayState}`);
      codeChallenge = parsed.codeChallenge;
      const url = new URL(parsed.redirectUri);
      url.searchParams.set('code', code);
      url.searchParams.set('state', relayState);
      target = url.toString();
    }
    const handoff: Handoff = { info, provider: samlProviderId(slug), codeChallenge };
    await this.cache.set(`saml-code:${sha256(code)}`, JSON.stringify(handoff), HANDOFF_TTL_SECONDS);
    return target;
  }

  /** Redeems a hand-off code once; with PKCE when the login was SP-initiated. */
  async redeem(
    code: string,
    codeVerifier: string | null,
    provider: string
  ): Promise<IdentityUserInfo> {
    const key = `saml-code:${sha256(code)}`;
    const raw = await this.cache.get(key);
    await this.cache.del(key);
    const handoff = raw ? (JSON.parse(raw) as Handoff) : null;
    if (!handoff || handoff.provider !== provider) {
      throw new IdentityError('invalid_grant', 'Unknown or used sign-in code');
    }
    if (handoff.codeChallenge !== (codeVerifier ? sha256(codeVerifier) : null)) {
      throw new IdentityError('invalid_grant', 'The sign-in code belongs to another login');
    }
    return handoff.info;
  }

  /** The dashboard's redirect flow, like OIDC. */
  provider(slug: string): RedirectIdentityProvider {
    const id = samlProviderId(slug);
    return {
      id,
      kind: 'redirect',
      displayName: 'SAML single sign-on',
      getAuthorizationUrl: async ({ state, codeChallenge, redirectUri }) => {
        const loaded = await this.load(slug);
        if (!loaded) throw new IdentityError('provider_unavailable', 'SAML is not set up');
        await this.cache.set(
          `saml-start:${slug}:${state}`,
          JSON.stringify({ codeChallenge, redirectUri }),
          START_TTL_SECONDS
        );
        return this.saml(slug, loaded.config, ValidateInResponseTo.always).getAuthorizeUrlAsync(
          state,
          undefined,
          {}
        );
      },
      handleCallback: ({ code, codeVerifier }) => this.redeem(code, codeVerifier, id),
    };
  }
}
