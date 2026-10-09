import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { FastifyInstance } from 'fastify';
import { buildApp } from '../app';
import { provisionSsoMember } from '../services/sso';
import { Fixtures, bearer } from './helpers/fixtures';

describe('SCIM 2.0 provisioning (M4.6, SSO-24/25/28)', () => {
  let app: FastifyInstance;
  let fx: Fixtures;
  let ws: string;
  let workspaceId: string;
  let owner: string;
  let ownerEmail: string;
  let token: string;
  const domain = `scim-${Date.now()}.example.com`;

  const scim = (
    method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
    url: string,
    payload?: object,
    as = token
  ) =>
    app.inject({
      method,
      url: `/scim/v2${url}`,
      headers: { authorization: `Bearer ${as}`, 'content-type': 'application/scim+json' },
      ...(payload && { payload: JSON.stringify(payload) }),
    });
  const admin = (method: 'GET' | 'POST' | 'DELETE', url: string) =>
    app.inject({ method, url: `/api/workspaces/${ws}${url}`, headers: bearer(owner) });
  const member = (email: string) =>
    app.container.systemDb.workspaceMember.findFirst({ where: { workspaceId, user: { email } } });
  const newUser = (email: string, extra: object = {}) =>
    scim('POST', '/Users', {
      schemas: ['urn:ietf:params:scim:schemas:core:2.0:User'],
      userName: email,
      name: { givenName: 'Test', familyName: 'User' },
      emails: [{ value: email, type: 'work', primary: true }],
      active: true,
      ...extra,
    });

  beforeAll(async () => {
    app = await buildApp();
    await app.ready();
    fx = new Fixtures(app);
    const { workspace } = await fx.workspace();
    ws = workspace.slug;
    workspaceId = workspace.id;
    const o = await fx.user();
    ownerEmail = o.email;
    await fx.member(workspace.id, o.id, 'owner');
    owner = await fx.session(o);
    // Group → role mapping comes from the SSO settings.
    await app.container.systemDb.workspaceConfig.upsert({
      where: { workspaceId },
      create: {
        workspaceId,
        oidcConfig: { roleMapping: { 'eng-admins': 'admin', engineers: 'developer' } },
        defaultSsoRole: 'viewer',
      },
      update: {},
    });
  });

  afterAll(async () => {
    await app.container.systemDb.user.deleteMany({ where: { email: { endsWith: `@${domain}` } } });
    await fx.cleanup();
    await app.close();
  });

  it('issues a token shown once and refuses anything else (SSO-24)', async () => {
    expect((await admin('GET', '/scim')).json()).toMatchObject({ enabled: false });
    const created = (await admin('POST', '/scim/token')).json();
    token = created.token;
    expect(token).toMatch(/^hq_scim_/);
    expect(created.baseUrl).toMatch(/\/scim\/v2$/);
    expect((await admin('GET', '/scim')).json()).toMatchObject({ enabled: true, users: 0 });
    const stored = await app.container.systemDb.workspaceConfig.findUnique({
      where: { workspaceId },
    });
    expect(stored?.scimTokenHash).not.toContain(token);

    const denied = await scim('GET', '/Users', undefined, 'hq_scim_nope');
    expect(denied.statusCode).toBe(401);
    expect(denied.json()).toMatchObject({
      schemas: ['urn:ietf:params:scim:api:messages:2.0:Error'],
      status: '401',
    });
    expect((await scim('GET', '/ServiceProviderConfig')).json().patch.supported).toBe(true);
  });

  it('provisions users as members and finds them by filter (SSO-25/28)', async () => {
    const email = `amy@${domain}`;
    const res = await newUser(email, { externalId: 'okta-amy' });
    expect(res.statusCode).toBe(201);
    expect(res.headers['content-type']).toContain('application/scim+json');
    const amy = res.json();
    expect(amy).toMatchObject({ userName: email, active: true, externalId: 'okta-amy' });
    expect(res.headers.location).toBe(amy.meta.location);
    expect((await member(email))?.role).toBe('viewer');
    expect((await newUser(email)).statusCode).toBe(409);
    expect((await newUser(`nobody`, { emails: [] })).statusCode).toBe(400);

    const found = (
      await scim(
        'GET',
        `/Users?filter=${encodeURIComponent(`userName eq "${email.toUpperCase()}"`)}`
      )
    ).json();
    expect(found).toMatchObject({ totalResults: 1, Resources: [{ id: amy.id }] });
    const byExternal = await scim(
      'GET',
      `/Users?filter=${encodeURIComponent('externalId eq "okta-amy"')}`
    );
    expect(byExternal.json().totalResults).toBe(1);
    expect(
      (await scim('GET', `/Users?filter=${encodeURIComponent('title co "x"')}`)).statusCode
    ).toBe(400);

    const audit = await app.container.systemDb.auditEvent.findFirst({
      where: { workspaceId, action: 'scim.user_provisioned' },
    });
    expect(audit?.metadata).toMatchObject({ userName: email, role: 'viewer' });
    const events = (await admin('GET', '/scim/events')).json().events;
    expect(events[0]).toMatchObject({ operation: 'POST /Users', statusCode: 400 });
    expect(events.find((e: { statusCode: number }) => e.statusCode === 201)?.scimUserId).toBe(
      amy.id
    );
  });

  it('maps groups to roles and follows membership changes (Okta and Entra ID shapes)', async () => {
    const ben = (await newUser(`ben@${domain}`)).json();
    const group = await scim('POST', '/Groups', {
      schemas: ['urn:ietf:params:scim:schemas:core:2.0:Group'],
      displayName: 'eng-admins',
      members: [{ value: ben.id }, { value: 'not-a-user' }],
    });
    expect(group.statusCode).toBe(201);
    expect(group.json().members).toEqual([{ value: ben.id, display: `ben@${domain}` }]);
    expect((await member(`ben@${domain}`))?.role).toBe('admin');
    expect((await scim('GET', `/Users/${ben.id}`)).json().groups).toEqual([
      { value: group.json().id, display: 'eng-admins' },
    ]);

    // Entra ID removes a member with a filtered path.
    await scim('PATCH', `/Groups/${group.json().id}`, {
      schemas: ['urn:ietf:params:scim:api:messages:2.0:PatchOp'],
      Operations: [{ op: 'Remove', path: `members[value eq "${ben.id}"]` }],
    });
    // Mapped groups exist, so no group means the default role.
    expect((await member(`ben@${domain}`))?.role).toBe('viewer');
    // Okta adds members with a value array.
    await scim('PATCH', `/Groups/${group.json().id}`, {
      Operations: [{ op: 'add', path: 'members', value: [{ value: ben.id }] }],
    });
    expect((await member(`ben@${domain}`))?.role).toBe('admin');
    // Renaming the group to something unmapped drops the role too.
    await scim('PATCH', `/Groups/${group.json().id}`, {
      Operations: [{ op: 'replace', value: { displayName: 'engineers' } }],
    });
    expect((await member(`ben@${domain}`))?.role).toBe('developer');
    expect((await scim('DELETE', `/Groups/${group.json().id}`)).statusCode).toBe(204);
    expect((await member(`ben@${domain}`))?.role).toBe('viewer');
  });

  it('deprovisions: membership, API keys and the workspace SSO sessions go (SSO-25)', async () => {
    const email = `cal@${domain}`;
    const cal = (await newUser(email)).json();
    const db = app.container.systemDb;
    const user = await db.user.findFirstOrThrow({ where: { email } });
    const key = await db.apiKey.create({
      data: { workspaceId, name: 'cal', keyHash: 'x', prefix: 'x', scopes: [], createdBy: user.id },
    });
    const session = await db.refreshToken.create({
      data: {
        userId: user.id,
        tokenHash: `scim-${Date.now()}`,
        familyId: 'f',
        expiresAt: new Date(Date.now() + 3_600_000),
        provider: `oidc:${ws}`,
      },
    });

    // Entra ID deactivates with a string boolean.
    const off = await scim('PATCH', `/Users/${cal.id}`, {
      Operations: [{ op: 'Replace', path: 'active', value: 'False' }],
    });
    expect(off.json().active).toBe(false);
    expect(await member(email)).toBeNull();
    expect((await db.apiKey.findUnique({ where: { id: key.id } }))?.revokedAt).not.toBeNull();
    expect(
      (await db.refreshToken.findUnique({ where: { id: session.id } }))?.revokedAt
    ).not.toBeNull();

    // SSO can't bring them back while the IdP says no.
    const policy = { roleMapping: {}, trustedDomains: [domain], defaultRole: 'viewer' as const };
    const sso = () =>
      provisionSsoMember(app, ws, `oidc:${ws}`, policy, user.id, {
        providerUserId: 'x',
        email,
        emailVerified: true,
      });
    await expect(sso()).rejects.toMatchObject({ code: 'access_denied' });

    await scim('PATCH', `/Users/${cal.id}`, {
      Operations: [{ op: 'replace', value: { active: true } }],
    });
    expect((await member(email))?.role).toBe('viewer');

    expect((await scim('DELETE', `/Users/${cal.id}`)).statusCode).toBe(204);
    expect((await scim('GET', `/Users/${cal.id}`)).statusCode).toBe(404);
    expect(await member(email)).toBeNull();
    await expect(sso()).rejects.toMatchObject({ code: 'access_denied' });
    // Provisioned again later: the same resource comes back.
    const back = await newUser(email);
    expect(back.statusCode).toBe(201);
    expect(back.json().id).toBe(cal.id);
    expect(await member(email)).not.toBeNull();
  });

  it('never removes the last owner', async () => {
    const ownerScim = (await newUser(ownerEmail)).json();
    await scim('PATCH', `/Users/${ownerScim.id}`, {
      Operations: [{ op: 'replace', path: 'active', value: false }],
    });
    expect((await member(ownerEmail))?.role).toBe('owner');
    const skipped = await app.container.systemDb.auditEvent.findFirst({
      where: { workspaceId, action: 'scim.deprovision_skipped' },
    });
    expect(skipped?.metadata).toMatchObject({ reason: 'last_owner' });
  });

  it('keeps workspaces apart and rotates tokens', async () => {
    const other = await fx.workspace();
    const o = await fx.user();
    await fx.member(other.workspace.id, o.id, 'owner');
    const otherToken = (
      await app.inject({
        method: 'POST',
        url: `/api/workspaces/${other.workspace.slug}/scim/token`,
        headers: bearer(await fx.session(o)),
      })
    ).json().token;
    const amy = (
      await scim('GET', `/Users?filter=${encodeURIComponent(`userName eq "amy@${domain}"`)}`)
    ).json().Resources[0];
    expect((await scim('GET', `/Users/${amy.id}`, undefined, otherToken)).statusCode).toBe(404);
    expect((await scim('GET', '/Users', undefined, otherToken)).json().totalResults).toBe(0);

    const old = token;
    token = (await admin('POST', '/scim/token')).json().token;
    expect((await scim('GET', '/Users', undefined, old)).statusCode).toBe(401);
    expect((await scim('GET', '/Users')).statusCode).toBe(200);
    expect((await admin('DELETE', '/scim')).statusCode).toBe(204);
    expect((await scim('GET', '/Users')).statusCode).toBe(401);
  });
});
