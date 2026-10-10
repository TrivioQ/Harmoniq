// Copyright The Harmoniq Authors
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { FastifyInstance } from 'fastify';
import { buildApp } from '../app';
import { Fixtures, bearer } from './helpers/fixtures';
import { MockS3, mockS3 } from './helpers/mockS3';

describe('Bring your own bucket (M4.9, BYOB-01..14)', () => {
  let app: FastifyInstance;
  let fx: Fixtures;
  let s3: MockS3;
  let admin: string;
  let key: string;
  let ws: string;
  let workspaceId: string;
  const cdn = 'https://cdn.acme.test/mfe';

  const api = (as: string, method: 'GET' | 'POST' | 'DELETE', url: string, payload?: object) =>
    app.inject({ method, url, payload, headers: bearer(as) });
  const storage = (method: 'GET' | 'POST' | 'DELETE', suffix = '', payload?: object) =>
    api(admin, method, `/api/workspaces/${ws}/storage${suffix}`, payload);
  const config = (extra: object = {}) => ({
    provider: 'S3',
    bucket: 'acme-mfe',
    region: 'eu-west-1',
    endpoint: s3.endpoint,
    cdnPrefix: cdn,
    pathPrefix: 'harmoniq',
    credentials: { accessKeyId: 'AKIAEXAMPLE', secretAccessKey: 'secret-key-1234' },
    ...extra,
  });
  const deploy = (body: object) =>
    api(key, 'POST', `/api/workspaces/${ws}/modules/checkout/deploy`, {
      environment: 'production',
      integrity: 'sha384-abc',
      ...body,
    });

  beforeAll(async () => {
    s3 = await mockS3();
    app = await buildApp();
    await app.ready();
    fx = new Fixtures(app);
    const { workspace } = await fx.workspace();
    ws = workspace.slug;
    workspaceId = workspace.id;
    const u = await fx.user();
    await fx.member(workspace.id, u.id, 'admin');
    admin = await fx.session(u);
    key = (await fx.apiKey(workspace.id, { scopes: ['admin'] })).raw;
  });

  afterAll(async () => {
    await fx.cleanup();
    await app.close();
    await s3.close();
  });

  it('verifies a bucket before saving it (BYOB-04)', async () => {
    s3.state.fail = true;
    const refused = await storage('POST', '', config());
    expect(refused.statusCode).toBe(400);
    expect(refused.json().error.message).toContain('storage test failed');
    expect((await storage('GET')).json().storageConfig).toBeNull();

    s3.state.fail = false;
    s3.state.requests.length = 0;
    const saved = await storage('POST', '', config());
    expect(saved.statusCode).toBe(200);
    expect(saved.json()).toMatchObject({ firstTime: true, check: { ok: true } });
    expect(saved.json().storageConfig.lastVerifiedAt).not.toBeNull();
    // Write, read back, delete, under the path prefix.
    expect(s3.state.requests.map((r) => r.split(' ')[0])).toEqual(['PUT', 'HEAD', 'DELETE']);
    expect(s3.state.requests[0]).toMatch(/^PUT \/acme-mfe\/harmoniq\/\.harmoniq\/probe-/);
    expect(s3.objects.size).toBe(0);
  });

  it('tests connections without saving (BYOB-05/06)', async () => {
    expect((await storage('POST', '/test')).json()).toMatchObject({ ok: true });
    // A candidate config is tested as given; the stored one stays.
    const other = await storage('POST', '/test', config({ endpoint: 'http://127.0.0.1:9' }));
    expect(other.json()).toMatchObject({ ok: false });
    expect((await storage('GET')).json().storageConfig.endpoint).toBe(s3.endpoint);

    // Rotated credentials are re-verified before they replace the old ones.
    s3.state.fail = true;
    const rotated = await storage(
      'POST',
      '',
      config({ credentials: { accessKeyId: 'AKIANEW', secretAccessKey: 'new-secret-5678' } })
    );
    expect(rotated.statusCode).toBe(400);
    s3.state.fail = false;
    expect((await storage('GET')).json().storageConfig.maskedCredentials.secretAccessKey).toBe(
      '••••1234'
    );
  });

  it('validates credentials per provider (BYOB-02/03)', async () => {
    const bad = async (body: object) => (await storage('POST', '/test', body)).statusCode;
    expect(await bad(config({ provider: 'LOCAL' }))).toBe(400);
    expect(
      await bad(config({ provider: 'AZURE', endpoint: undefined, credentials: { key: 'x' } }))
    ).toBe(400);
    expect(
      await bad(
        config({
          provider: 'GCS',
          endpoint: undefined,
          credentials: { serviceAccountJson: '{not json' },
        })
      )
    ).toBe(400);
    expect(await bad(config({ credentials: { roleArn: 'not-an-arn' } }))).toBe(400);
    // Switching provider needs new credentials.
    expect(
      await bad({ provider: 'AZURE', bucket: 'c', region: 'westeurope', cdnPrefix: cdn })
    ).toBe(400);
  });

  it('issues upload URLs in the workspace bucket and serves from its CDN (BYOB-07/08)', async () => {
    const upload = await api(key, 'POST', `/api/workspaces/${ws}/modules/checkout/upload-url`, {
      contentType: 'application/javascript',
      extension: 'js',
    });
    expect(upload.statusCode).toBe(200);
    const { uploadUrl, key: objectKey, url } = upload.json();
    expect(uploadUrl.startsWith(`${s3.endpoint}/acme-mfe/harmoniq/modules/`)).toBe(true);
    expect(objectKey).toMatch(/^harmoniq\/modules\/.+\.js$/);
    expect(url).toBe(`${cdn}/${objectKey}`);

    // Deployed by object key: the manifest URL is the CDN one, whatever the client sent.
    const deployed = await deploy({
      version: '1.0.0',
      url: 'https://acme-mfe.s3.eu-west-1.amazonaws.com/whatever.js',
      storagePath: objectKey,
    });
    expect(deployed.statusCode).toBe(201);
    expect(deployed.json().url).toBe(`${cdn}/${objectKey}`);
    const manifest = (
      await app.inject({ method: 'GET', url: `/api/manifest/${ws}/portal/production` })
    ).json();
    expect(manifest.modules[0].url).toBe(`${cdn}/${objectKey}`);
    // The published manifest lands in the workspace bucket, not the instance storage.
    expect([...s3.objects.keys()]).toContain(
      '/acme-mfe/harmoniq/manifests/' + ws + '/portal/production.json'
    );
  });

  it('flags URLs outside the CDN prefix and records where deploys went (BYOB-10/14)', async () => {
    const elsewhere = await deploy({
      version: '1.1.0',
      url: 'https://other-cdn.example.com/checkout.js',
    });
    expect(elsewhere.statusCode).toBe(201);
    expect(elsewhere.json().warnings).toEqual([expect.stringContaining('CDN prefix')]);
    const event = await app.container.systemDb.auditEvent.findFirst({
      where: { workspaceId, action: 'module.deploy' },
      orderBy: { createdAt: 'desc' },
    });
    expect(event?.metadata).toMatchObject({ storageProvider: 'S3', storageRegion: 'eu-west-1' });
  });

  it('fails closed when the workspace bucket is broken (BYOB-09)', async () => {
    await app.container.systemDb.workspaceStorageConfig.update({
      where: { workspaceId },
      data: { credentialsEncrypted: { v: 1, iv: 'x', tag: 'x', ct: 'x' } },
    });
    const upload = await api(key, 'POST', `/api/workspaces/${ws}/modules/checkout/upload-url`, {});
    expect(upload.statusCode).toBe(503);
    expect(upload.json().error.code).toBe('STORAGE_UNAVAILABLE');
    expect((await deploy({ version: '1.2.0', url: `${cdn}/x.js` })).statusCode).toBe(503);
    // Nothing changed: the manifest still serves the last good version.
    const manifest = (
      await app.inject({ method: 'GET', url: `/api/manifest/${ws}/portal/production` })
    ).json();
    expect(manifest.modules[0].version).toBe('1.1.0');
  });

  it('removes the bucket: new deploys go to the instance default (BYOB-11)', async () => {
    expect((await storage('DELETE')).statusCode).toBe(204);
    expect((await storage('GET')).json().storageConfig).toBeNull();
    expect((await storage('DELETE')).statusCode).toBe(404);
    // Instance storage in tests is the local disk: no pre-signed uploads, said plainly.
    const upload = await api(key, 'POST', `/api/workspaces/${ws}/modules/checkout/upload-url`, {});
    expect(upload.statusCode).toBe(400);
    expect(upload.json().error.message).toContain("can't issue upload URLs");
  });
});
