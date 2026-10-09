import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { createHmac, randomUUID } from 'crypto';
import { FastifyInstance } from 'fastify';
import { buildApp } from '../app';
import { handleWebhookDelivery } from '../jobs/webhooks';
import { ConsoleLogger } from '../adapters/ConsoleLogger';
import { Fixtures, bearer } from './helpers/fixtures';

describe('Workspace administration', () => {
  let app: FastifyInstance;
  let fx: Fixtures;
  let ownerToken: string;
  let slug: string;

  const as = (token: string) => ({
    get: (url: string) => app.inject({ method: 'GET', url, headers: bearer(token) }),
    post: (url: string, payload?: object) =>
      app.inject({ method: 'POST', url, payload: payload ?? {}, headers: bearer(token) }),
    patch: (url: string, payload: object) =>
      app.inject({ method: 'PATCH', url, payload, headers: bearer(token) }),
    del: (url: string) => app.inject({ method: 'DELETE', url, headers: bearer(token) }),
  });

  beforeAll(async () => {
    app = await buildApp();
    await app.ready();
    fx = new Fixtures(app);
    const owner = await fx.user();
    ownerToken = await fx.session(owner);
    slug = `ws-${randomUUID().slice(0, 8)}`;
  });

  afterAll(async () => {
    await app.container.systemDb.workspace.deleteMany({ where: { slug } });
    await fx.cleanup();
    await app.close();
  });

  describe('workspaces', () => {
    it('lets a user create a workspace they own, with a default host app', async () => {
      const res = await as(ownerToken).post('/api/workspaces', { name: 'Acme', slug });
      expect(res.statusCode).toBe(201);

      const ws = await as(ownerToken).get(`/api/workspaces/${slug}`);
      expect(ws.json()).toMatchObject({
        role: 'owner',
        hostApps: [
          {
            slug: 'default',
            isDefault: true,
            environments: [{ slug: 'production' }, { slug: 'staging' }],
          },
        ],
      });
    });

    it('rejects taken and invalid slugs', async () => {
      expect((await as(ownerToken).post('/api/workspaces', { name: 'X', slug })).statusCode).toBe(
        409
      );
      expect(
        (await as(ownerToken).post('/api/workspaces', { name: 'X', slug: 'Bad Slug' })).statusCode
      ).toBe(400);
    });
  });

  describe('API keys', () => {
    const deployWith = async (key: string) => {
      await as(ownerToken).post(`/api/workspaces/${slug}/modules`, {
        hostApp: 'default',
        name: 'Nav',
        slug: 'nav',
      });
      return app.inject({
        method: 'POST',
        url: `/api/workspaces/${slug}/modules/nav/deploy`,
        headers: bearer(key),
        payload: {
          environment: 'staging',
          url: 'https://cdn.example.com/nav.js',
          version: randomUUID().slice(0, 6),
          integrity: 'sha384-x',
        },
      });
    };

    it('shows the raw key once and never again', async () => {
      const res = await as(ownerToken).post(`/api/workspaces/${slug}/api-keys`, { name: 'CI' });
      expect(res.statusCode).toBe(201);
      expect(res.json().key).toMatch(/^hq_/);
      expect((await deployWith(res.json().key)).statusCode).toBe(201);

      const list = await as(ownerToken).get(`/api/workspaces/${slug}/api-keys`);
      expect(list.payload).not.toContain(res.json().key);
      expect(list.payload).not.toContain('keyHash');
    });

    it('stops working immediately when revoked', async () => {
      const { id, key } = (
        await as(ownerToken).post(`/api/workspaces/${slug}/api-keys`, { name: 'tmp' })
      ).json();
      expect((await deployWith(key)).statusCode).toBe(201); // now cached as valid
      expect((await as(ownerToken).del(`/api/workspaces/${slug}/api-keys/${id}`)).statusCode).toBe(
        200
      );
      expect((await deployWith(key)).statusCode).toBe(401);
    });

    it('rotates with a grace period for the old key', async () => {
      const old = (
        await as(ownerToken).post(`/api/workspaces/${slug}/api-keys`, { name: 'rot' })
      ).json();
      const graceful = await as(ownerToken).post(
        `/api/workspaces/${slug}/api-keys/${old.id}/rotate`,
        {
          gracePeriodHours: 1,
        }
      );
      expect(graceful.statusCode).toBe(201);
      expect((await deployWith(graceful.json().key)).statusCode).toBe(201);
      expect((await deployWith(old.key)).statusCode).toBe(201);

      const immediate = await as(ownerToken).post(
        `/api/workspaces/${slug}/api-keys/${graceful.json().id}/rotate`,
        { gracePeriodHours: 0 }
      );
      expect((await deployWith(graceful.json().key)).statusCode).toBe(401);
      expect((await deployWith(immediate.json().key)).statusCode).toBe(201);
    });

    it('cannot be used to create more keys', async () => {
      const admin = (
        await as(ownerToken).post(`/api/workspaces/${slug}/api-keys`, {
          name: 'admin',
          scopes: ['admin'],
        })
      ).json();
      expect(
        (await as(admin.key).post(`/api/workspaces/${slug}/api-keys`, { name: 'x' })).statusCode
      ).toBe(403);
    });
  });

  describe('members', () => {
    it('invites by email; the invitee is pending until they sign in', async () => {
      const res = await as(ownerToken).post(`/api/workspaces/${slug}/members`, {
        email: `Invitee-${randomUUID()}@Example.com`,
        role: 'developer',
      });
      expect(res.statusCode).toBe(201);
      expect(res.json()).toMatchObject({ status: 'invited', role: 'developer' });
      expect(res.json().email).toBe(res.json().email.toLowerCase());
    });

    it('lets only owners grant ownership and never removes the last owner', async () => {
      const ws = (await app.container.systemDb.workspace.findUnique({ where: { slug } }))!;
      const admin = await fx.user();
      await fx.member(ws.id, admin.id, 'admin');
      const adminToken = await fx.session(admin);

      expect(
        (
          await as(adminToken).post(`/api/workspaces/${slug}/members`, {
            email: 'x@example.com',
            role: 'owner',
          })
        ).statusCode
      ).toBe(403);

      const members = (await as(ownerToken).get(`/api/workspaces/${slug}/members`)).json().members;
      const owner = members.find((m: { role: string }) => m.role === 'owner');
      expect(
        (await as(ownerToken).del(`/api/workspaces/${slug}/members/${owner.id}`)).statusCode
      ).toBe(409);
      expect(
        (
          await as(ownerToken).patch(`/api/workspaces/${slug}/members/${owner.id}`, {
            role: 'admin',
          })
        ).statusCode
      ).toBe(409);
    });

    it('cannot be managed by developers', async () => {
      const ws = (await app.container.systemDb.workspace.findUnique({ where: { slug } }))!;
      const dev = await fx.user();
      await fx.member(ws.id, dev.id, 'developer');
      const res = await as(await fx.session(dev)).post(`/api/workspaces/${slug}/members`, {
        email: 'y@example.com',
        role: 'viewer',
      });
      expect(res.statusCode).toBe(403);
    });
  });

  describe('webhooks', () => {
    it('refuses internal URLs', async () => {
      const res = await as(ownerToken).post(`/api/workspaces/${slug}/webhooks`, {
        url: 'http://169.254.169.254/hook',
        events: ['deploy.success'],
      });
      expect(res.statusCode).toBe(400);
    });

    it('stores the signing secret encrypted and signs deliveries with it', async () => {
      const res = await as(ownerToken).post(`/api/workspaces/${slug}/webhooks`, {
        url: 'https://8.8.8.8/hook',
        events: ['*'],
      });
      expect(res.statusCode).toBe(201);
      const { id, secret } = res.json();
      expect(secret).toMatch(/^whsec_/);

      const stored = await app.container.systemDb.webhookEndpoint.findUniqueOrThrow({
        where: { id },
      });
      expect(stored.secret).not.toContain(secret);
      expect(stored.secret.startsWith('enc:v1:')).toBe(true);
      expect((await as(ownerToken).get(`/api/workspaces/${slug}/webhooks`)).payload).not.toContain(
        secret
      );

      const fetchMock = vi.fn().mockResolvedValue(new Response('ok', { status: 200 }));
      vi.stubGlobal('fetch', fetchMock);
      try {
        await handleWebhookDelivery(
          {
            data: {
              workspaceId: stored.workspaceId,
              webhookEndpointId: id,
              event: 'deploy.success',
              payload: { hello: 'world' },
              attempt: 0,
              firstAttemptAt: new Date().toISOString(),
            },
          },
          app.container.systemDb,
          new ConsoleLogger(),
          { send: vi.fn() } as never,
          { encryptionKey: app.config.encryptionKey }
        );
      } finally {
        vi.unstubAllGlobals();
      }
      const [, init] = fetchMock.mock.calls[0];
      const expected = createHmac('sha256', secret).update(init.body).digest('hex');
      expect(init.headers['X-Harmoniq-Signature']).toBe(expected);
    });
  });
});
