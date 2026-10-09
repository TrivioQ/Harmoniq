import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Ajv from 'ajv';
import { FastifyInstance } from 'fastify';
import { buildApp } from '../app';
import { Fixtures, bearer } from './helpers/fixtures';

describe('Public manifest JSON Schema', () => {
  let app: FastifyInstance;
  let fx: Fixtures;

  beforeAll(async () => {
    app = await buildApp();
    await app.ready();
    fx = new Fixtures(app);
  });

  afterAll(async () => {
    await fx.cleanup();
    await app.close();
  });

  it('validates real manifests and rejects malformed ones', async () => {
    const { workspace } = await fx.workspace();
    const key = (await fx.apiKey(workspace.id)).raw;
    await app.inject({
      method: 'POST',
      url: `/api/workspaces/${workspace.slug}/modules/checkout/deploy`,
      headers: bearer(key),
      payload: {
        environment: 'staging',
        url: 'https://cdn.example.com/c.js',
        version: '1.0.0',
        integrity: 'sha384-a',
        dependencies: { react: '^18.0.0' },
      },
    });

    const schemaRes = await app.inject({ method: 'GET', url: '/api/schema/manifest.json' });
    expect(schemaRes.headers['content-type']).toContain('application/schema+json');
    const validate = new Ajv({ strict: false }).compile(schemaRes.json());

    const manifest = (
      await app.inject({ method: 'GET', url: `/api/manifest/${workspace.slug}/portal/staging` })
    ).json();
    validate(manifest);
    expect(validate.errors ?? []).toEqual([]);
    expect(validate(manifest)).toBe(true);
    expect(validate({ ...manifest, futureField: true })).toBe(true); // forward compatible
    expect(validate({ ...manifest, schemaVersion: 1 })).toBe(false);
    expect(validate({ ...manifest, modules: [{ name: 'x' }] })).toBe(false);
  });
});
