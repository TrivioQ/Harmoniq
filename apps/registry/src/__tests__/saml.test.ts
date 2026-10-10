import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createHash, randomBytes } from 'crypto';
import { FastifyInstance } from 'fastify';
import { buildApp } from '../app';
import { Fixtures, bearer } from './helpers/fixtures';
import { IDP, mockSamlIdp, requestIdOf } from './helpers/mockSaml';

type SamlIdp = Awaited<ReturnType<typeof mockSamlIdp>>;

describe('SAML single sign-on (M4.5, SSO-09..20)', () => {
  let app: FastifyInstance;
  let fx: Fixtures;
  let ws: string;
  let workspaceId: string;
  let owner: string;
  let idp: SamlIdp;
  let idpCert: string;
  const domain = `saml-${Date.now()}.example.com`;
  const redirectUri = 'http://localhost:3000/api/auth/callback/saml';
  const urls = () => ({
    acs: `http://localhost:4000/auth/saml/${ws}/acs`,
    entityId: `http://localhost:4000/auth/saml/${ws}/metadata`,
  });

  const api = (
    as: string | null,
    method: 'GET' | 'POST' | 'PUT' | 'DELETE',
    url: string,
    payload?: object
  ) => app.inject({ method, url, payload, headers: as ? bearer(as) : {} });

  /** A signed SAML response from the test IdP. */
  const response = (opts: Parameters<SamlIdp['response']>[1]) => idp.response(urls(), opts);

  const postAcs = (xml: string, relayState?: string) =>
    app.inject({
      method: 'POST',
      url: `/auth/saml/${ws}/acs`,
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: new URLSearchParams({
        SAMLResponse: Buffer.from(xml).toString('base64'),
        ...(relayState && { RelayState: relayState }),
      }).toString(),
    });
  /** Dashboard start → IdP → ACS → dashboard callback. */
  async function login(email: string, groups: string[] = [], opts: { tamper?: boolean } = {}) {
    const state = randomBytes(16).toString('base64url');
    const verifier = randomBytes(32).toString('base64url');
    const codeChallenge = createHash('sha256').update(verifier).digest('base64url');
    const start = await api(null, 'POST', `/api/auth/saml:${ws}/start`, {
      state,
      codeChallenge,
      redirectUri,
    });
    expect(start.statusCode).toBe(200);
    const authorizationUrl = start.json().authorizationUrl as string;
    let xml = response({ email, groups, inResponseTo: requestIdOf(authorizationUrl) });
    if (opts.tamper) xml = xml.replace(`>${email}<`, '>attacker@evil.test<');
    const acs = await postAcs(xml, state);
    const location = new URL(acs.headers.location as string);
    return { acs, location, verifier, authorizationUrl };
  }
  const exchange = (code: string, codeVerifier: string) =>
    api(null, 'POST', `/api/auth/saml:${ws}/callback`, { code, codeVerifier, redirectUri });

  beforeAll(async () => {
    idp = await mockSamlIdp();
    idpCert = idp.cert;
    app = await buildApp();
    await app.ready();
    fx = new Fixtures(app);
    const { workspace } = await fx.workspace();
    ws = workspace.slug;
    workspaceId = workspace.id;
    const o = await fx.user();
    await fx.member(workspace.id, o.id, 'owner');
    owner = await fx.session(o);
  });

  afterAll(async () => {
    await app.container.systemDb.user.deleteMany({ where: { email: { endsWith: `@${domain}` } } });
    await fx.cleanup();
    await app.close();
  });

  it('imports IdP metadata and serves SP metadata with a generated key (SSO-11/15/17/18)', async () => {
    const certBody = idpCert.replace(/-----[A-Z ]+-----|\s/g, '');
    const metadataXml = `<md:EntityDescriptor xmlns:md="urn:oasis:names:tc:SAML:2.0:metadata" entityID="${IDP}"><md:IDPSSODescriptor protocolSupportEnumeration="urn:oasis:names:tc:SAML:2.0:protocol"><md:KeyDescriptor use="signing"><ds:KeyInfo xmlns:ds="http://www.w3.org/2000/09/xmldsig#"><ds:X509Data><ds:X509Certificate>${certBody}</ds:X509Certificate></ds:X509Data></ds:KeyInfo></md:KeyDescriptor><md:SingleLogoutService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect" Location="${IDP}/slo"/><md:SingleSignOnService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST" Location="${IDP}/sso-post"/><md:SingleSignOnService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect" Location="${IDP}/sso"/></md:IDPSSODescriptor></md:EntityDescriptor>`;
    const imported = await api(owner, 'POST', `/api/workspaces/${ws}/sso/saml/import`, {
      metadataXml,
    });
    expect(imported.json()).toEqual({
      idpEntityId: IDP,
      idpSsoUrl: `${IDP}/sso`,
      idpSloUrl: `${IDP}/slo`,
      idpCert: certBody,
    });
    expect(
      (await api(owner, 'POST', `/api/workspaces/${ws}/sso/saml/import`, { metadataXml: '<x/>' }))
        .statusCode
    ).toBe(400);

    const res = await api(owner, 'PUT', `/api/workspaces/${ws}/sso/saml`, {
      ...imported.json(),
      attributeMapping: { email: 'mail', groups: 'memberOf' },
      roleMapping: { 'harmoniq-devs': 'developer', 'harmoniq-admins': 'admin' },
      trustedDomains: [domain],
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().serviceProvider).toMatchObject({
      acs: urls().acs,
      entityId: urls().entityId,
    });
    expect(res.json().saml.spPrivateKey).toBeUndefined();
    const stored = await app.container.systemDb.workspaceConfig.findUnique({
      where: { workspaceId },
    });
    expect(JSON.stringify(stored?.samlConfig)).not.toContain('PRIVATE KEY');

    const metadata = await app.inject({ method: 'GET', url: `/auth/saml/${ws}/metadata` });
    expect(metadata.headers['content-type']).toContain('samlmetadata+xml');
    expect(metadata.body).toContain(`entityID="${urls().entityId}"`);
    expect(metadata.body).toContain(urls().acs);
    expect(metadata.body).toContain('X509Certificate');
  });

  it('signs in SP-initiated with a one-time code bound to PKCE (SSO-09/10/14/16/21/23)', async () => {
    const email = `lee@${domain}`;
    const { location, verifier, authorizationUrl } = await login(email, [
      'harmoniq-devs',
      'harmoniq-admins',
    ]);
    expect(new URL(authorizationUrl).searchParams.get('Signature')).toBeTruthy(); // signed AuthnRequest
    expect(location.origin + location.pathname).toBe(redirectUri);
    const code = location.searchParams.get('code')!;

    expect((await exchange(code, 'wrong-verifier-' + 'x'.repeat(30))).statusCode).toBe(401);
    // The failed attempt used up the code too; log in again.
    const again = await login(email, ['harmoniq-devs', 'harmoniq-admins']);
    const session = await exchange(again.location.searchParams.get('code')!, again.verifier);
    expect(session.statusCode).toBe(200);
    expect(session.json().user.email).toBe(email);
    expect(
      (await exchange(again.location.searchParams.get('code')!, again.verifier)).statusCode
    ).toBe(401);
    expect(verifier).not.toBe(again.verifier);

    const member = await app.container.systemDb.workspaceMember.findFirst({
      where: { workspaceId, user: { email } },
    });
    expect(member?.role).toBe('admin');
  });

  it('refuses tampered, replayed, foreign and unsolicited responses', async () => {
    const tampered = await login(`kim@${domain}`, [], { tamper: true });
    expect(tampered.location.pathname).toBe('/auth/login');
    expect(tampered.location.searchParams.get('error')).toBe('invalid_token');

    const state = randomBytes(16).toString('base64url');
    const unsolicited = await postAcs(response({ email: `kim@${domain}` }), state);
    expect(new URL(unsolicited.headers.location as string).searchParams.get('error')).toBe(
      'invalid_grant'
    );

    const start = await api(null, 'POST', `/api/auth/saml:${ws}/start`, {
      state,
      codeChallenge: createHash('sha256').update('v'.repeat(43)).digest('base64url'),
      redirectUri,
    });
    const id = requestIdOf(start.json().authorizationUrl);
    const wrongAudience = await postAcs(
      response({ email: `kim@${domain}`, inResponseTo: id, audience: 'https://other.example' }),
      state
    );
    expect(new URL(wrongAudience.headers.location as string).searchParams.get('error')).toBe(
      'invalid_token'
    );
  });

  it('accepts IdP-initiated logins only when allowed (SSO-09)', async () => {
    const xml = () => response({ email: `ida@${domain}` });
    expect(
      new URL((await postAcs(xml())).headers.location as string).searchParams.get('error')
    ).toBe('invalid_grant');
    const current = (await api(owner, 'GET', `/api/workspaces/${ws}/sso/saml`)).json().saml;
    await api(owner, 'PUT', `/api/workspaces/${ws}/sso/saml`, {
      ...current,
      providerId: undefined,
      spCert: undefined,
      allowIdpInitiated: true,
    });
    const location = new URL((await postAcs(xml())).headers.location as string);
    expect(location.pathname).toBe('/api/auth/saml/idp');
    const redeemed = await api(null, 'POST', '/api/auth/saml/redeem', {
      code: location.searchParams.get('code'),
      provider: `saml:${ws}`,
    });
    expect(redeemed.statusCode).toBe(200);
    expect(redeemed.json().user.email).toBe(`ida@${domain}`);
  });

  it('tests the connection without creating a session (SSO-20)', async () => {
    const test = await api(owner, 'POST', `/api/workspaces/${ws}/sso/saml/test`);
    const { id, url } = test.json();
    expect(new URL(url).searchParams.get('RelayState')).toBe(`test:${id}`);
    const acs = await postAcs(
      response({
        email: `tess@${domain}`,
        groups: ['harmoniq-devs'],
        inResponseTo: requestIdOf(url),
      }),
      `test:${id}`
    );
    expect(acs.headers.location).toContain(`/w/${ws}/settings/sso?samlTest=${id}`);
    const result = (await api(owner, 'GET', `/api/workspaces/${ws}/sso/saml/test/${id}`)).json();
    expect(result.mapped).toMatchObject({ email: `tess@${domain}`, groups: ['harmoniq-devs'] });
    expect(result.attributes.mail).toBe(`tess@${domain}`);
    expect(
      await app.container.systemDb.user.findFirst({ where: { email: `tess@${domain}` } })
    ).toBeNull();
  });

  it('scopes SSO sessions to their workspace', async () => {
    const email = `lee@${domain}`;
    const { location, verifier } = await login(email, ['harmoniq-devs']);
    const session = (await exchange(location.searchParams.get('code')!, verifier)).json();
    const lee = await app.container.systemDb.user.findFirstOrThrow({ where: { email } });
    const other = await fx.workspace();
    await fx.member(other.workspace.id, lee.id, 'admin');

    const elsewhere = await api(
      session.accessToken,
      'GET',
      `/api/workspaces/${other.workspace.slug}/modules`
    );
    expect(elsewhere.statusCode).toBe(403);
    expect(elsewhere.json().error.code).toBe('SSO_SCOPED');
    expect(
      (await api(session.accessToken, 'GET', `/api/workspaces/${ws}/modules`)).statusCode
    ).toBe(200);
    const me = (await api(session.accessToken, 'GET', '/api/me')).json();
    expect(me.workspaces.map((w: { slug: string }) => w.slug)).toEqual([ws]);
    expect(
      (
        await api(session.accessToken, 'POST', '/api/workspaces', {
          name: 'x',
          slug: `x-${Date.now()}`,
        })
      ).statusCode
    ).toBe(403);
    // Signed in another way, the same person reaches both.
    const direct = await fx.session(lee);
    expect(
      (await api(direct, 'GET', `/api/workspaces/${other.workspace.slug}/modules`)).statusCode
    ).toBe(200);
  });
});
