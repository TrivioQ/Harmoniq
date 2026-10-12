// Copyright The Harmoniq Authors
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { randomUUID } from 'crypto';
import { FastifyInstance } from 'fastify';
import { buildApp } from '../app';
import { TXT_PREFIX, challengeRecord } from '../services/domains';
import { handleDomainRecheck } from '../jobs/domains';
import { Fixtures, bearer } from './helpers/fixtures';

// DOM-01..05: domains proven by DNS before SSO relies on them.
describe('Verified domains (DOM-01..05)', () => {
  let app: FastifyInstance;
  let fx: Fixtures;
  let alice: string; // admin of orgA
  let bob: string; // admin of orgB
  let member: string; // org_member of orgA
  let root: string; // instance admin
  const id = randomUUID().slice(0, 8);
  const orgA = `doma-${id}`;
  const orgB = `domb-${id}`;
  const domain = `acme-${id}.example.test`;
  /** TXT records the stub resolver answers with, by record name. */
  const dns = new Map<string, string[]>();

  const api = (
    as: string | null,
    method: 'GET' | 'POST' | 'DELETE',
    url: string,
    payload?: object
  ) => app.inject({ method, url, payload, headers: as ? bearer(as) : {} });
  const db = () => app.container.systemDb;
  const publish = (record: { name: string; value: string }) =>
    dns.set(record.name, [...(dns.get(record.name) ?? []), record.value]);
  const setGrace = async (until: Date) => {
    await db().instanceConfig.upsert({
      where: { key: 'domains.graceUntil' },
      create: { key: 'domains.graceUntil', value: { at: until.toISOString() }, updatedBy: 'test' },
      update: { value: { at: until.toISOString() } },
    });
    app.container.domains.forgetGrace();
  };
  const ssoConfig = (trustedDomains: string[]) => ({
    issuer: 'https://idp.example.test',
    clientId: 'c',
    clientSecret: 'sealed',
    trustedDomains,
  });
  const discover = (email: string) => api(null, 'GET', `/api/auth/sso/discover?email=${email}`);

  beforeAll(async () => {
    app = await buildApp();
    await app.ready();
    fx = new Fixtures(app);
    app.container.domains.resolveTxt = async (name) => {
      const values = dns.get(name);
      if (!values) throw Object.assign(new Error('queryTxt ENOTFOUND'), { code: 'ENOTFOUND' });
      return values.map((v) => [v]);
    };
    const [a, b, m, r] = await Promise.all([
      fx.user(),
      fx.user(),
      fx.user(),
      fx.user({ instanceAdmin: true }),
    ]);
    [alice, bob, member, root] = await Promise.all([a, b, m, r].map((u) => fx.session(u)));
    for (const [as, slug] of [
      [alice, orgA],
      [bob, orgB],
    ] as const) {
      expect((await api(as, 'POST', '/api/orgs', { name: slug, slug })).statusCode).toBe(201);
    }
    await api(alice, 'POST', `/api/orgs/${orgA}/members`, { email: m.email });
    await setGrace(new Date(Date.now() + 86_400_000));
  });

  afterEach(() => app.container.domains.forgetGrace());

  afterAll(async () => {
    await setGrace(new Date(Date.now() + 30 * 86_400_000));
    await db().workspace.deleteMany({ where: { organization: { slug: { in: [orgA, orgB] } } } });
    await db().organization.deleteMany({ where: { slug: { in: [orgA, orgB] } } });
    await fx.cleanup();
    await app.close();
  });

  it('claims a domain and returns the TXT record to publish (DOM-01)', async () => {
    const res = await api(alice, 'POST', `/api/orgs/${orgA}/domains`, {
      domain: domain.toUpperCase(),
    });
    expect(res.statusCode).toBe(201);
    const claim = res.json();
    expect(claim).toMatchObject({ domain, verified: false });
    expect(claim.record).toMatchObject({ type: 'TXT', name: challengeRecord(domain) });
    expect(claim.record.value).toMatch(new RegExp(`^${TXT_PREFIX}[0-9a-f]{32}$`));

    // Claiming again returns the same record.
    const again = await api(alice, 'POST', `/api/orgs/${orgA}/domains`, { domain });
    expect(again.statusCode).toBe(200);
    expect(again.json().record.value).toBe(claim.record.value);

    for (const bad of ['https://acme.test', '*.acme.test', 'localhost', '']) {
      const res = await api(alice, 'POST', `/api/orgs/${orgA}/domains`, { domain: bad });
      expect(res.statusCode).toBe(400);
    }
    expect((await api(member, 'POST', `/api/orgs/${orgA}/domains`, { domain })).statusCode).toBe(
      403
    );
  });

  it('verifies only once the TXT record is published (DOM-01)', async () => {
    const verify = () => api(alice, 'POST', `/api/orgs/${orgA}/domains/${domain}/verify`);
    const missing = await verify();
    expect(missing.statusCode).toBe(400);
    expect(missing.json().error.message).toContain(challengeRecord(domain));

    const [claim] = (await api(alice, 'GET', `/api/orgs/${orgA}/domains`)).json().domains;
    dns.set(claim.record.name, ['v=spf1 -all']); // unrelated records don't count
    expect((await verify()).statusCode).toBe(400);
    publish(claim.record);
    const ok = await verify();
    expect(ok.statusCode).toBe(200);
    expect(ok.json().verified).toBe(true);
    expect(
      await db().organizationAuditEvent.findFirst({
        where: {
          action: 'domain.verify',
          resourceId: domain,
          organizationId: (await db().organization.findUniqueOrThrow({ where: { slug: orgA } })).id,
        },
      })
    ).not.toBeNull();
  });

  it('lets only one tenant verify a domain (DOM-02)', async () => {
    const claim = (await api(bob, 'POST', `/api/orgs/${orgB}/domains`, { domain })).json();
    publish(claim.record);
    const res = await api(bob, 'POST', `/api/orgs/${orgB}/domains/${domain}/verify`);
    expect(res.statusCode).toBe(409);
    expect(res.json().error.message).toContain('verified by another');
  });

  it('relies only on domains the tenant may use for SSO (DOM-01..04)', async () => {
    const { domains } = app.container;
    const other = `other-${id}.example.test`;
    // orgA verified `domain`; nobody verified `other`.
    expect(
      await domains.usableTrustedDomains({ kind: 'organization', slug: orgA }, [domain, other])
    ).toEqual([domain, other]);
    expect(
      await domains.usableTrustedDomains({ kind: 'organization', slug: orgB }, [domain, other])
    ).toEqual([other]);

    // A workspace of orgA relies on its organization's domains.
    const res = await api(alice, 'POST', `/api/orgs/${orgA}/workspaces`, {
      name: 'Shop',
      slug: `${orgA}-shop`,
    });
    expect(res.statusCode).toBe(201);
    expect(
      await domains.usableTrustedDomains({ kind: 'workspace', slug: `${orgA}-shop` }, [domain])
    ).toEqual([domain]);

    // After the grace period, unverified domains stop counting.
    await setGrace(new Date(Date.now() - 1000));
    expect(
      await domains.usableTrustedDomains({ kind: 'organization', slug: orgB }, [domain, other])
    ).toEqual([]);
    expect(
      await domains.usableTrustedDomains({ kind: 'organization', slug: orgA }, [domain, other])
    ).toEqual([domain]);
    await setGrace(new Date(Date.now() + 86_400_000));
  });

  it('discovers SSO by verified domain, and by an unambiguous listing only during grace (DOM-03/04)', async () => {
    await db().organization.update({
      where: { slug: orgA },
      data: { oidcConfig: ssoConfig([domain]) },
    });
    // orgB lists the domain too, but orgA verified it.
    await db().organization.update({
      where: { slug: orgB },
      data: { oidcConfig: ssoConfig([domain]) },
    });
    const found = await discover(`someone@${domain}`);
    expect(found.statusCode).toBe(200);
    expect(found.json()).toMatchObject({
      provider: `org-oidc:${orgA}`,
      organization: { slug: orgA },
    });

    const unclaimed = `solo-${id}.example.test`;
    await db().organization.update({
      where: { slug: orgB },
      data: { oidcConfig: ssoConfig([domain, unclaimed]) },
    });
    expect((await discover(`x@${unclaimed}`)).json().provider).toBe(`org-oidc:${orgB}`);

    // A second tenant listing it makes it ambiguous.
    await db().organization.update({
      where: { slug: orgA },
      data: { oidcConfig: ssoConfig([domain, unclaimed]) },
    });
    expect((await discover(`x@${unclaimed}`)).statusCode).toBe(404);

    // After the grace period, only verified domains route.
    await db().organization.update({
      where: { slug: orgA },
      data: { oidcConfig: ssoConfig([domain]) },
    });
    await setGrace(new Date(Date.now() - 1000));
    expect((await discover(`x@${unclaimed}`)).statusCode).toBe(404);
    expect((await discover(`x@${domain}`)).json().provider).toBe(`org-oidc:${orgA}`);
    await setGrace(new Date(Date.now() + 86_400_000));
  });

  it('works for workspaces too', async () => {
    const ws = `${orgA}-shop`;
    const wsDomain = `shop-${id}.example.test`;
    const claim = await api(alice, 'POST', `/api/workspaces/${ws}/domains`, { domain: wsDomain });
    expect(claim.statusCode).toBe(201);
    publish(claim.json().record);
    expect(
      (await api(alice, 'POST', `/api/workspaces/${ws}/domains/${wsDomain}/verify`)).json().verified
    ).toBe(true);
    expect(
      (await api(alice, 'GET', `/api/workspaces/${ws}/domains`))
        .json()
        .domains.map((d: { domain: string }) => d.domain)
    ).toEqual([wsDomain]);
    expect(
      (await api(alice, 'DELETE', `/api/workspaces/${ws}/domains/${wsDomain}`)).statusCode
    ).toBe(204);
  });

  it('unverifies a domain whose record is gone for 14 days (DOM-05)', async () => {
    const row = await db().verifiedDomain.findUniqueOrThrow({ where: { verifiedDomain: domain } });
    dns.delete(challengeRecord(domain));
    const { domains, logger } = app.container;
    const t0 = new Date(Date.now() + 7 * 86_400_000); // due for a re-check

    await handleDomainRecheck(db(), domains, logger, t0);
    const failing = await db().verifiedDomain.findUniqueOrThrow({ where: { id: row.id } });
    expect(failing.failingSince).toEqual(t0);
    expect(failing.verifiedAt).not.toBeNull();

    const t14 = new Date(t0.getTime() + 14 * 86_400_000);
    const result = await handleDomainRecheck(db(), domains, logger, t14);
    expect(result.unverified).toBeGreaterThanOrEqual(1);
    const gone = await db().verifiedDomain.findUniqueOrThrow({ where: { id: row.id } });
    expect(gone).toMatchObject({ verifiedAt: null, verifiedDomain: null });
    expect(
      await db().organizationAuditEvent.findFirst({
        where: { action: 'domain.unverified', resourceId: domain },
      })
    ).not.toBeNull();
  });

  it('keeps a failing domain verified when its record comes back', async () => {
    const d = `back-${id}.example.test`;
    const claim = (await api(alice, 'POST', `/api/orgs/${orgA}/domains`, { domain: d })).json();
    publish(claim.record);
    await api(alice, 'POST', `/api/orgs/${orgA}/domains/${d}/verify`);
    const { domains, logger } = app.container;
    dns.delete(claim.record.name);
    await handleDomainRecheck(db(), domains, logger, new Date(Date.now() + 7 * 86_400_000));
    publish(claim.record);
    await handleDomainRecheck(db(), domains, logger, new Date(Date.now() + 8 * 86_400_000));
    expect(
      await db().verifiedDomain.findUniqueOrThrow({ where: { verifiedDomain: d } })
    ).toMatchObject({ failingSince: null });
  });

  it('lets instance admins find and release claims (DOM-02)', async () => {
    const list = await api(root, 'GET', `/api/admin/domains?domain=${id}`);
    expect(list.statusCode).toBe(200);
    const claims = list.json().domains as Array<{ id: string; organization: string }>;
    const bobs = claims.find((c) => c.organization === orgB)!;
    expect((await api(alice, 'DELETE', `/api/admin/domains/${bobs.id}`)).statusCode).toBe(403);
    expect((await api(root, 'DELETE', `/api/admin/domains/${bobs.id}`)).statusCode).toBe(204);
    expect(
      await db().instanceAuditEvent.findFirst({
        where: { action: 'instance.domain_release', resourceId: domain },
      })
    ).not.toBeNull();
  });
});
