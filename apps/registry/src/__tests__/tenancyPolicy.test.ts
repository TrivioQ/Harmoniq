// Copyright The Harmoniq Authors
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { randomUUID } from 'crypto';
import { FastifyInstance } from 'fastify';
import { buildApp } from '../app';
import { Fixtures, bearer } from './helpers/fixtures';

// TLC-08: who may create organizations and standalone workspaces.
describe('Tenant creation policy (TLC-08)', () => {
  let app: FastifyInstance;
  let fx: Fixtures;
  let root: string;
  const run = randomUUID().slice(0, 8);
  const created: string[] = [];
  const users: string[] = [];

  const db = () => app.container.systemDb;
  const as = async (email: string) => {
    const user = await db().user.create({ data: { email } });
    users.push(user.id);
    return fx.session(user);
  };
  let n = 0;
  const createWorkspace = async (token: string) => {
    const slug = `ten-${run}-${n++}`;
    created.push(slug);
    return app.inject({
      method: 'POST',
      url: '/api/workspaces',
      payload: { name: slug, slug },
      headers: bearer(token),
    });
  };
  const createOrg = async (token: string) => {
    const slug = `teno-${run}-${n++}`;
    return app.inject({
      method: 'POST',
      url: '/api/orgs',
      payload: { name: slug, slug },
      headers: bearer(token),
    });
  };
  const policy = (value: object) =>
    app.inject({
      method: 'PUT',
      url: '/api/admin/settings/tenancy',
      payload: value,
      headers: bearer(root),
    });
  const reset = async () => {
    await db().instanceConfig.deleteMany({ where: { key: 'settings.tenancy' } });
    await app.container.settings.reload();
  };

  beforeAll(async () => {
    app = await buildApp();
    await app.ready();
    fx = new Fixtures(app);
    await reset();
    root = await fx.session(await fx.user({ instanceAdmin: true }));
  });

  afterEach(reset);

  afterAll(async () => {
    await db().workspace.deleteMany({ where: { slug: { startsWith: `ten-${run}` } } });
    await db().organization.deleteMany({ where: { slug: { startsWith: `teno-${run}` } } });
    await db().verifiedDomain.deleteMany({ where: { domain: `verified-${run}.test` } });
    await db().user.deleteMany({ where: { id: { in: users } } });
    await fx.cleanup();
    await app.close();
  });

  it('lets anyone create by default', async () => {
    const user = await as(`a-${run}@anywhere.test`);
    expect((await createWorkspace(user)).statusCode).toBe(201);
    expect((await createOrg(user)).statusCode).toBe(201);
  });

  it('can limit creation to instance admins', async () => {
    expect((await policy({ creation: 'instance_admins' })).statusCode).toBe(200);
    const user = await as(`b-${run}@anywhere.test`);
    const refused = await createWorkspace(user);
    expect(refused.statusCode).toBe(403);
    expect(refused.json().error.message).toContain('Only instance admins');
    expect((await createOrg(user)).statusCode).toBe(403);
    expect((await createWorkspace(root)).statusCode).toBe(201);
  });

  it('still lets org admins create workspaces in their organization', async () => {
    const admin = await as(`c-${run}@anywhere.test`);
    const org = (await createOrg(admin)).json().slug;
    await policy({ creation: 'instance_admins' });
    const slug = `ten-${run}-org`;
    created.push(slug);
    const res = await app.inject({
      method: 'POST',
      url: `/api/orgs/${org}/workspaces`,
      payload: { name: slug, slug },
      headers: bearer(admin),
    });
    expect(res.statusCode).toBe(201);
  });

  it('can limit creation to approved and verified email domains', async () => {
    await policy({ creation: 'verified_domains', allowedDomains: ['Allowed.TEST'] });
    expect((await createWorkspace(await as(`d-${run}@allowed.test`))).statusCode).toBe(201);
    expect((await createWorkspace(await as(`e-${run}@other.test`))).statusCode).toBe(403);

    // A domain some tenant verified (DOM-01) counts too.
    const org = await db().organization.create({ data: { slug: `teno-${run}-v`, name: 'v' } });
    const domain = `verified-${run}.test`;
    await db().verifiedDomain.create({
      data: {
        domain,
        organizationId: org.id,
        token: 't',
        verifiedAt: new Date(),
        verifiedDomain: domain,
        createdBy: 'test',
      },
    });
    expect((await createOrg(await as(`f-${run}@${domain}`))).statusCode).toBe(201);
  });

  it('validates the setting', async () => {
    expect((await policy({ creation: 'nobody' })).statusCode).toBe(400);
    expect(
      (await policy({ creation: 'verified_domains', allowedDomains: ['not a domain'] })).statusCode
    ).toBe(400);
  });
});
