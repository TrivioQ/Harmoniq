import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFile } from 'fs/promises';
import { join } from 'path';
import { FastifyInstance } from 'fastify';
import { buildApp } from '../app';
import { openapiDocument } from '../openapiDocument';

describe('OpenAPI document (OAS-01/02)', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildApp();
    await app.ready();
  });
  afterAll(() => app.close());

  it('docs/openapi.json matches the routes (run `pnpm --filter @harmoniq/registry openapi:generate`)', async () => {
    const committed = await readFile(join(__dirname, '../../../../docs/openapi.json'), 'utf8');
    expect(JSON.parse(committed)).toEqual(JSON.parse(openapiDocument(app)));
  });

  it('documents request bodies, tags and authentication', () => {
    const spec = app.swagger() as unknown as {
      paths: Record<string, Record<string, Record<string, unknown>>>;
    };
    const deploy = spec.paths['/api/workspaces/{workspaceSlug}/modules/{moduleRef}/deploy'].post;
    expect(deploy.tags).toEqual(['Modules and versions']);
    expect(deploy.security).toEqual([{ bearerAuth: [] }]);
    expect(JSON.stringify(deploy.requestBody)).toContain('integrity');
    const manifest = spec.paths['/api/manifest/{workspaceSlug}/{hostAppSlug}/{env}'].get;
    expect(manifest.security).toBeUndefined();
    expect(Object.keys(spec.paths).some((p) => p.startsWith('/docs'))).toBe(false);
  });
});
