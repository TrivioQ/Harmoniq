import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createHash, randomBytes, randomUUID } from 'crypto';
import { FastifyInstance } from 'fastify';
import { buildApp } from '../app';
import { Fixtures, bearer } from './helpers/fixtures';
import { MockIdp, mockIdp } from './helpers/mockOidc';
import { IDP, mockSamlIdp, requestIdOf } from './helpers/mockSaml';

describe('Organization SSO and SCIM (M4.7b, ORG-05..07)', () => {
  let app: FastifyInstance;
  let fx: Fixtures;
  let idp: MockIdp;
  let alice: string; // org admin, signed in directly
  let aliceId: string;
  let carol: string; // workspace owner outside the org
  const org = `org-${randomUUID().slice(0, 8)}`;
  const inherits = `inh-${randomUUID().slice(0, 8)}`; // uses the org's SSO
  const own = `own-${randomUUID().slice(0, 8)}`; // has its own SSO (overrides)
  let outside: string;
  const domain = `orgsso-${Date.now()}.example.com`;
  const redirectUri = 'http://localhost:3000/api/auth/callback/org';

  const api = (
    as: string | null,
    method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
    url: string,
    payload?: object
  ) => app.inject({ method, url, payload, headers: as ? bearer(as) : {} });
  const db = () => app.container.systemDb;
  const membership = (slug: string, email: string) =>
    db().workspaceMember.findFirst({ where: { workspace: { slug }, user: { email } } });
  const orgMembership = (email: string) =>
    db().organizationMember.findFirst({ where: { organization: { slug: org }, user: { email } } });

  /** Start → IdP → callback through a provider id; returns the session tokens. */
  async function oidcLogin(provider: string, user: Record<string, unknown>) {
    const verifier = randomBytes(32).toString('base64url');
    const start = await api(null, 'POST', `/api/auth/${provider}/start`, {
      state: randomBytes(16).toString('base64url'),
      codeChallenge: createHash('sha256').update(verifier).digest('base64url'),
      redirectUri,
    });
    expect(start.statusCode).toBe(200);
    const code = idp.authorize(start.json().authorizationUrl, user);
    return api(null, 'POST', `/api/auth/${provider}/callback`, {
      code,
      codeVerifier: verifier,
      redirectUri,
    });
  }
  const orgLogin = (email: string, groups: string[] = []) =>
    oidcLogin(`org-oidc:${org}`, { sub: email, email, email_verified: true, groups });

  beforeAll(async () => {
    idp = await mockIdp();
    app = await buildApp();
    await app.ready();
    fx = new Fixtures(app);
    const [a, c] = await Promise.all([fx.user(), fx.user()]);
    aliceId = a.id;
    [alice, carol] = await Promise.all([fx.session(a), fx.session(c)]);
    const o = await fx.workspace();
    outside = o.workspace.slug;
    await fx.member(o.workspace.id, c.id, 'owner');

    expect((await api(alice, 'POST', '/api/orgs', { name: 'SSO Org', slug: org })).statusCode).toBe(
      201
    );
    for (const slug of [inherits, own]) {
      const res = await api(alice, 'POST', `/api/orgs/${org}/workspaces`, { name: slug, slug });
      expect(res.statusCode).toBe(201);
    }
    // `own` overrides the organization's SSO with its own.
    const wsOidc = await api(alice, 'PUT', `/api/workspaces/${own}/sso/oidc`, {
      issuer: idp.issuer,
      clientId: 'workspace-client',
      clientSecret: 'workspace-secret-123',
    });
    expect(wsOidc.statusCode).toBe(200);
  });

  afterAll(async () => {
    await db().workspace.deleteMany({ where: { organization: { slug: org } } });
    await db().organization.deleteMany({ where: { slug: org } });
    await db().user.deleteMany({ where: { email: { endsWith: `@${domain}` } } });
    await fx.cleanup();
    await app.close();
    await idp.close();
  });

  it('configures org OIDC and group rules; only org admins (ORG-05/07)', async () => {
    const config = {
      issuer: idp.issuer,
      clientId: 'org-client',
      clientSecret: 'org-secret-12345',
      trustedDomains: [domain],
    };
    expect((await api(carol, 'PUT', `/api/orgs/${org}/sso/oidc`, config)).statusCode).toBe(404);
    const saved = await api(alice, 'PUT', `/api/orgs/${org}/sso/oidc`, config);
    expect(saved.statusCode).toBe(200);
    expect(saved.json().oidc).toMatchObject({ providerId: `org-oidc:${org}` });
    expect(saved.json().oidc.clientSecret).not.toContain('org-secret');

    // Rules must point at the org's own workspaces.
    expect(
      (
        await api(alice, 'PUT', `/api/orgs/${org}/provisioning`, {
          rules: [{ group: 'eng', workspace: outside, role: 'developer' }],
        })
      ).statusCode
    ).toBe(400);
    const rules = await api(alice, 'PUT', `/api/orgs/${org}/provisioning`, {
      rules: [
        { group: 'eng', workspace: inherits, role: 'developer' },
        { group: 'leads', workspace: inherits, role: 'admin' },
        { group: 'eng', workspace: own, role: 'developer' },
      ],
      adminGroups: ['org-admins'],
    });
    expect(rules.statusCode).toBe(200);

    const overview = (await api(alice, 'GET', `/api/orgs/${org}/sso`)).json();
    expect(overview.workspaces).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ slug: inherits, own: null }),
        expect.objectContaining({ slug: own, own: 'oidc' }),
      ])
    );
    // Discovery finds the org for its domain.
    expect((await api(null, 'GET', `/api/auth/sso/discover?email=x@${domain}`)).json()).toEqual({
      provider: `org-oidc:${org}`,
      organization: { slug: org, name: 'SSO Org' },
    });
  });

  it('org SSO provisions the org and workspaces from group rules (ORG-05/07)', async () => {
    const email = `dana@${domain}`;
    const login = await orgLogin(email, ['eng', 'leads']);
    expect(login.statusCode).toBe(200);
    expect((await orgMembership(email))?.role).toBe('org_member');
    // Most permissive rule wins; workspaces with their own SSO are left to it.
    expect(await membership(inherits, email)).toMatchObject({
      role: 'admin',
      orgProvisioned: true,
    });
    expect(await membership(own, email)).toBeNull();

    // A group goes away: the role follows, then the membership the rules granted.
    await orgLogin(email, ['eng']);
    expect((await membership(inherits, email))?.role).toBe('developer');
    await orgLogin(email, []);
    expect(await membership(inherits, email)).toBeNull();
    expect((await orgMembership(email))?.role).toBe('org_member');

    // Admin groups make org admins; the IdP never demotes one.
    await orgLogin(email, ['org-admins']);
    expect((await orgMembership(email))?.role).toBe('org_admin');
    await orgLogin(email, []);
    expect((await orgMembership(email))?.role).toBe('org_admin');

    // Untrusted domains without a matching group don't join.
    await orgLogin(`eve-${Date.now()}@elsewhere.example.org`, []);
    const strangers = await db().organizationMember.count({
      where: {
        organization: { slug: org },
        user: { email: { endsWith: '@elsewhere.example.org' } },
      },
    });
    expect(strangers).toBe(0);
    await db().user.deleteMany({ where: { email: { endsWith: '@elsewhere.example.org' } } });
  });

  it('org SSO sessions reach the org’s inheriting workspaces only (ORG-05)', async () => {
    const email = `finn@${domain}`;
    const session = (await orgLogin(email, ['eng'])).json().accessToken as string;
    expect((await api(session, 'GET', `/api/workspaces/${inherits}/modules`)).statusCode).toBe(200);
    const elsewhere = await api(session, 'GET', `/api/workspaces/${outside}/modules`);
    expect(elsewhere.statusCode).toBe(403);
    expect(elsewhere.json().error.code).toBe('SSO_SCOPED');
    // The workspace's own SSO overrides the org's, so the org's IdP can't vouch there.
    await db().workspaceMember.create({
      data: {
        workspace: { connect: { slug: own } },
        user: { connect: { email } },
        role: 'viewer',
        joinedAt: new Date(),
      },
    });
    expect((await api(session, 'GET', `/api/workspaces/${own}/modules`)).json().error.code).toBe(
      'SSO_SCOPED'
    );

    // Its org's routes work; creating orgs or standalone workspaces doesn't.
    expect((await api(session, 'GET', `/api/orgs/${org}`)).statusCode).toBe(200);
    expect(
      (await api(session, 'POST', '/api/orgs', { name: 'x', slug: `x-${org}` })).statusCode
    ).toBe(403);
    const me = (await api(session, 'GET', '/api/me')).json();
    expect(me.workspaces.map((w: { slug: string }) => w.slug)).toEqual([inherits]);
    expect(me.organizations.map((o: { slug: string }) => o.slug)).toEqual([org]);
    expect(me.user.isInstanceAdmin).toBe(false);
  });

  it('forced org SSO applies to inheriting workspaces; owners are exempt (ORG-05)', async () => {
    const email = `gus@${domain}`;
    const gus = await db().user.create({ data: { email } });
    const direct = await fx.session(gus);
    await db().workspaceMember.create({
      data: {
        workspace: { connect: { slug: inherits } },
        user: { connect: { id: gus.id } },
        role: 'developer',
        joinedAt: new Date(),
      },
    });
    await api(alice, 'PUT', `/api/orgs/${org}/sso/oidc`, {
      issuer: idp.issuer,
      clientId: 'org-client',
      trustedDomains: [domain],
      forceSso: true,
    });
    const denied = await api(direct, 'GET', `/api/workspaces/${inherits}/modules`);
    expect(denied.statusCode).toBe(403);
    expect(denied.json().error.code).toBe('SSO_REQUIRED');
    // Alice owns the workspace (break-glass); `own` has its own (unforced) SSO.
    expect((await api(alice, 'GET', `/api/workspaces/${inherits}/modules`)).statusCode).toBe(200);
    expect((await api(alice, 'GET', `/api/workspaces/${own}/modules`)).statusCode).toBe(200);
    const viaSso = (await orgLogin(email, ['eng'])).json().accessToken as string;
    expect((await api(viaSso, 'GET', `/api/workspaces/${inherits}/modules`)).statusCode).toBe(200);
    await api(alice, 'PUT', `/api/orgs/${org}/sso/oidc`, {
      issuer: idp.issuer,
      clientId: 'org-client',
      trustedDomains: [domain],
      forceSso: false,
    });
  });

  it('serves org SAML at /auth/org-saml/:orgSlug (ORG-06)', async () => {
    const saml = mockSamlIdp();
    const certBody = saml.cert.replace(/-----[A-Z ]+-----|\s/g, '');
    const saved = await api(alice, 'PUT', `/api/orgs/${org}/sso/saml`, {
      idpEntityId: IDP,
      idpSsoUrl: `${IDP}/sso`,
      idpCert: certBody,
      attributeMapping: { email: 'mail', groups: 'memberOf' },
      trustedDomains: [domain],
    });
    expect(saved.statusCode).toBe(200);
    const sp = saved.json().serviceProvider;
    expect(sp.acs).toBe(`http://localhost:4000/auth/org-saml/${org}/acs`);
    const metadata = await api(null, 'GET', `/auth/org-saml/${org}/metadata`);
    expect(metadata.statusCode).toBe(200);
    expect(metadata.body).toContain(sp.entityId);
    expect((await api(null, 'GET', `/auth/org-saml/nope-${org}/metadata`)).statusCode).toBe(404);

    // SP-initiated sign-in through the dashboard flow.
    const email = `hana@${domain}`;
    const state = randomBytes(16).toString('base64url');
    const verifier = randomBytes(32).toString('base64url');
    const start = await api(null, 'POST', `/api/auth/org-saml:${org}/start`, {
      state,
      codeChallenge: createHash('sha256').update(verifier).digest('base64url'),
      redirectUri,
    });
    const xml = saml.response(sp, {
      email,
      groups: ['eng'],
      inResponseTo: requestIdOf(start.json().authorizationUrl),
    });
    const acs = await app.inject({
      method: 'POST',
      url: `/auth/org-saml/${org}/acs`,
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: new URLSearchParams({
        SAMLResponse: Buffer.from(xml).toString('base64'),
        RelayState: state,
      }).toString(),
    });
    expect(acs.statusCode).toBe(303);
    const code = new URL(acs.headers.location as string).searchParams.get('code')!;
    const callback = await api(null, 'POST', `/api/auth/org-saml:${org}/callback`, {
      code,
      codeVerifier: verifier,
      redirectUri,
    });
    expect(callback.statusCode).toBe(200);
    expect((await membership(inherits, email))?.role).toBe('developer');

    // Test connection returns to the org settings page.
    const test = (await api(alice, 'POST', `/api/orgs/${org}/sso/saml/test`)).json();
    const tested = await app.inject({
      method: 'POST',
      url: `/auth/org-saml/${org}/acs`,
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: new URLSearchParams({
        SAMLResponse: Buffer.from(
          saml.response(sp, { email, inResponseTo: requestIdOf(test.url) })
        ).toString('base64'),
        RelayState: `test:${test.id}`,
      }).toString(),
    });
    expect(tested.headers.location).toContain(`/orgs/${org}/sso?samlTest=${test.id}`);
    expect((await api(alice, 'DELETE', `/api/orgs/${org}/sso/saml`)).statusCode).toBe(204);
  });

  describe('org SCIM (ORG-07)', () => {
    let token: string;
    const scim = (
      method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
      url: string,
      payload?: object,
      opts: { as?: string; slug?: string } = {}
    ) =>
      app.inject({
        method,
        url: `/scim/v2/orgs/${opts.slug ?? org}${url}`,
        headers: {
          authorization: `Bearer ${opts.as ?? token}`,
          'content-type': 'application/scim+json',
        },
        ...(payload && { payload: JSON.stringify(payload) }),
      });
    const newUser = (email: string) =>
      scim('POST', '/Users', {
        schemas: ['urn:ietf:params:scim:schemas:core:2.0:User'],
        userName: email,
        emails: [{ value: email, primary: true }],
        active: true,
      });

    it('authenticates with the org token at the org path only', async () => {
      const created = (await api(alice, 'POST', `/api/orgs/${org}/scim/token`)).json();
      token = created.token;
      expect(created.baseUrl).toBe(`http://localhost:4000/scim/v2/orgs/${org}`);
      expect((await scim('GET', '/Users')).statusCode).toBe(200);
      expect((await scim('GET', '/Users', undefined, { slug: outside })).statusCode).toBe(401);
      expect((await scim('GET', '/Users', undefined, { as: 'hq_scim_nope' })).statusCode).toBe(401);
      // Not a workspace token either.
      const wsRes = await app.inject({
        method: 'GET',
        url: '/scim/v2/Users',
        headers: { authorization: `Bearer ${token}` },
      });
      expect(wsRes.statusCode).toBe(401);
    });

    it('provisions into the org and assigns workspaces by group rules', async () => {
      const email = `ivy@${domain}`;
      const ivy = await newUser(email);
      expect(ivy.statusCode).toBe(201);
      expect(ivy.json().meta.location).toContain(`/scim/v2/orgs/${org}/Users/`);
      expect((await orgMembership(email))?.role).toBe('org_member');
      expect(await membership(inherits, email)).toBeNull();

      const group = await scim('POST', '/Groups', {
        displayName: 'leads',
        members: [{ value: ivy.json().id }],
      });
      expect(group.statusCode).toBe(201);
      expect((await membership(inherits, email))?.role).toBe('admin');
      // `own` has no SCIM of its own, so the org's rules apply there too.
      await scim('PATCH', `/Groups/${group.json().id}`, {
        Operations: [{ op: 'replace', path: 'displayName', value: 'eng' }],
      });
      expect((await membership(inherits, email))?.role).toBe('developer');
      expect((await membership(own, email))?.role).toBe('developer');

      // SSO doesn't change access while the org's SCIM decides.
      await orgLogin(email, []);
      expect((await membership(inherits, email))?.role).toBe('developer');

      const events = (await api(alice, 'GET', `/api/orgs/${org}/scim/events`)).json().events;
      expect(events.length).toBeGreaterThan(0);
      expect(events.every((e: { workspaceId: string | null }) => e.workspaceId === null)).toBe(
        true
      );
      // Org SCIM rows are invisible to workspace tenants.
      const wsId = (await db().workspace.findUniqueOrThrow({ where: { slug: inherits } })).id;
      const visible = await app.container.withTenant(wsId, (tx) =>
        tx.scimUser.count({ where: { user: { email } } })
      );
      expect(visible).toBe(0);
    });

    it('deprovisions across the org: memberships, keys, sessions; SSO refused', async () => {
      const email = `jay@${domain}`;
      const jay = (await newUser(email)).json();
      const user = await db().user.findFirstOrThrow({ where: { email } });
      const eng = (await scim('GET', '/Groups?filter=displayName eq "eng"')).json().Resources[0];
      await scim('PATCH', `/Groups/${eng.id}`, {
        Operations: [{ op: 'add', path: 'members', value: [{ value: jay.id }] }],
      });
      expect(await membership(inherits, email)).not.toBeNull();
      const wsId = (await db().workspace.findUniqueOrThrow({ where: { slug: inherits } })).id;
      const key = await db().apiKey.create({
        data: { workspaceId: wsId, name: 'jay', keyHash: 'x', prefix: 'x', createdBy: user.id },
      });
      const session = await db().refreshToken.create({
        data: {
          userId: user.id,
          tokenHash: `orgscim-${Date.now()}`,
          familyId: 'f',
          expiresAt: new Date(Date.now() + 3_600_000),
          provider: `org-oidc:${org}`,
        },
      });

      const off = await scim('PATCH', `/Users/${jay.id}`, {
        Operations: [{ op: 'replace', path: 'active', value: 'False' }],
      });
      expect(off.json().active).toBe(false);
      expect(await orgMembership(email)).toBeNull();
      expect(await membership(inherits, email)).toBeNull();
      expect(await membership(own, email)).toBeNull();
      expect((await db().apiKey.findUnique({ where: { id: key.id } }))?.revokedAt).not.toBeNull();
      expect(
        (await db().refreshToken.findUnique({ where: { id: session.id } }))?.revokedAt
      ).not.toBeNull();

      const denied = await orgLogin(email, ['eng']);
      expect(denied.statusCode).toBe(401);
      expect(denied.json().error.code).toBe('ACCESS_DENIED');

      expect((await scim('DELETE', `/Users/${jay.id}`)).statusCode).toBe(204);
      expect((await orgLogin(email, ['eng'])).statusCode).toBe(401);
    });

    it('keeps the last org admin', async () => {
      const ali = (await newUser(`ali-${Date.now()}@${domain}`)).json();
      // Alice is the only org admin besides Dana (promoted earlier); demote Dana first.
      const dana = await orgMembership(`dana@${domain}`);
      await db().organizationMember.update({
        where: { id: dana!.id },
        data: { role: 'org_member' },
      });
      const aliceUser = await db().user.findUniqueOrThrow({ where: { id: aliceId } });
      const aliceScim = (await newUser(aliceUser.email)).json();
      await scim('DELETE', `/Users/${aliceScim.id}`);
      expect((await orgMembership(aliceUser.email))?.role).toBe('org_admin');
      await scim('DELETE', `/Users/${ali.id}`);
    });

    it('disables the token', async () => {
      expect((await api(alice, 'DELETE', `/api/orgs/${org}/scim`)).statusCode).toBe(204);
      expect((await scim('GET', '/Users')).statusCode).toBe(401);
    });
  });
});
