import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { FastifyInstance } from 'fastify';
import { buildApp } from '../app';
import { Fixtures, bearer } from './helpers/fixtures';

describe('Dependency and contract gate (M3.7)', () => {
  let app: FastifyInstance;
  let fx: Fixtures;
  let ws: string;
  let workspaceId: string;
  let token: string;

  const api = (method: 'GET' | 'POST' | 'PATCH', url: string, payload?: object) =>
    app.inject({ method, url, payload, headers: bearer(token) });
  const deploy = (
    module: string,
    version: string,
    extra: object = {},
    environment = 'production'
  ) =>
    api('POST', `/api/workspaces/${ws}/modules/${module}/deploy`, {
      environment,
      url: `https://cdn.example.com/${module}/${version}.js`,
      version,
      integrity: 'sha384-abc',
      ...extra,
    });

  beforeAll(async () => {
    app = await buildApp();
    await app.ready();
    fx = new Fixtures(app);
    const { workspace, hostApp } = await fx.workspace();
    ws = workspace.slug;
    workspaceId = workspace.id;
    await fx.module(workspace.id, hostApp.id, 'cart');
    const owner = await fx.user();
    await fx.member(workspace.id, owner.id, 'owner');
    token = await fx.session(owner);
    expect((await deploy('cart', '1.0.0', { dependencies: { react: '^18.2.0' } })).statusCode).toBe(
      201
    );
  });

  afterAll(async () => {
    await fx.cleanup();
    await app.close();
  });

  it('rejects a deploy whose ranges conflict with another module (422)', async () => {
    const res = await deploy('checkout', '1.0.0', { dependencies: { react: '^19.0.0' } });
    expect(res.statusCode).toBe(422);
    expect(res.json().error.message).toMatch(
      /react: \^19\.0\.0 \(checkout\) vs \^18\.2\.0 \(cart\)/
    );
    expect(res.json().error.details.dependencyConflicts[0]).toMatchObject({
      package: 'react',
      reason: 'no_common_version',
    });
    expect(
      (await deploy('checkout', '1.0.0', { dependencies: { react: '^18.3.0' } })).statusCode
    ).toBe(201);
  });

  it('reports conflicts in a dry run without deploying', async () => {
    const res = await deploy('checkout', '1.1.0', {
      dependencies: { react: '^17.0.0' },
      dryRun: true,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().validation).toMatchObject({
      blockedByGate: true,
      dependencyConflicts: [{ package: 'react' }],
    });
  });

  it('deploys with force, audited as module.deploy_forced', async () => {
    const res = await deploy('checkout', '2.0.0', {
      dependencies: { react: '^19.0.0' },
      force: true,
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().warnings).toContain('Deployed despite the dependency gate (forced)');
    const audit = await app.container.systemDb.auditEvent.findFirst({
      where: { workspaceId, action: 'module.deploy_forced' },
    });
    expect(audit?.metadata).toMatchObject({
      version: '2.0.0',
      dependencyConflicts: [{ package: 'react' }],
    });
  });

  it('checks host shared dependencies, which must be valid ranges', async () => {
    const bad = await api('PATCH', `/api/workspaces/${ws}/host-apps/portal`, {
      sharedDependencies: { react: 'not-a-range' },
    });
    expect(bad.statusCode).toBe(400);
    const set = await api('PATCH', `/api/workspaces/${ws}/host-apps/portal`, {
      sharedDependencies: { react: '>=18 <19' },
    });
    expect(set.json().sharedDependencies).toEqual({ react: '>=18 <19' });
    // Undo the forced ^19 checkout from the previous test.
    expect(
      (await deploy('checkout', '2.1.0', { dependencies: { react: '^18.3.0' } })).statusCode
    ).toBe(201);
    // cart ^18 is fine with the host; ^19 isn't.
    expect((await deploy('cart', '1.1.0', { dependencies: { react: '^18.3.0' } })).statusCode).toBe(
      201
    );
    const res = await deploy('cart', '2.0.0', { dependencies: { react: '^19.0.0' } });
    expect(res.statusCode).toBe(422);
    expect(res.json().error.message).toContain('(host)');
  });

  it('serves the dependency matrix with conflicts (DEP-04)', async () => {
    await deploy('checkout', '2.2.0', { dependencies: { react: '^19.0.0' }, force: true });
    const res = await api(
      'GET',
      `/api/workspaces/${ws}/host-apps/portal/environments/production/dependencies`
    );
    expect(res.statusCode).toBe(200);
    const matrix = res.json();
    expect(matrix.packages).toEqual(['react']);
    expect(matrix.sources.map((s: { name: string }) => s.name)).toEqual([
      '(host)',
      'cart',
      'checkout',
    ]);
    // checkout ^19 (forced) conflicts with cart ^18 and the host.
    expect(
      matrix.conflicts
        .map((c: { between: Array<{ source: string }> }) =>
          c.between
            .map((b) => b.source)
            .sort()
            .join('+')
        )
        .sort()
    ).toEqual(['(host)+checkout', 'cart+checkout']);
  });

  it('warns about removed exposes, and blocks them for strict host apps', async () => {
    const exposes = (paths: string[]) => Object.fromEntries(paths.map((p) => [p, p]));
    await deploy('cart', '3.0.0', { exposes: exposes(['./Cart', './MiniCart']) });
    const warned = await deploy('cart', '3.1.0', { exposes: exposes(['./Cart']) });
    expect(warned.statusCode).toBe(201);
    expect(warned.json().warnings).toEqual(['Removes exposed modules: ./MiniCart']);

    await api('PATCH', `/api/workspaces/${ws}/host-apps/portal`, { strictExposes: true });
    const blocked = await deploy('cart', '3.2.0', { exposes: exposes([]) });
    expect(blocked.statusCode).toBe(422);
    expect(blocked.json().error.details.removedExposes).toEqual(['./Cart']);
  });

  it('applies to promotions into an environment', async () => {
    await deploy('checkout', '5.0.0', { dependencies: { react: '^18.3.0' } }, 'staging');
    await deploy('cart', '5.0.0', { dependencies: { react: '^17.0.0' }, force: true }, 'staging');
    // In staging, checkout ^18 and cart ^17 coexist only because cart was forced; promoting
    // cart to production meets the host's >=18 <19.
    const res = await api('POST', `/api/workspaces/${ws}/modules/cart/promote`, {
      fromEnvironment: 'staging',
      toEnvironment: 'production',
    });
    expect(res.statusCode).toBe(422);
    const forced = await api('POST', `/api/workspaces/${ws}/modules/cart/promote`, {
      fromEnvironment: 'staging',
      toEnvironment: 'production',
      force: true,
    });
    expect(forced.statusCode).toBe(201);
  });
});
