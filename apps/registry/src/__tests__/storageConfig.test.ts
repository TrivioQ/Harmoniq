// Copyright The Harmoniq Authors
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { FastifyInstance } from 'fastify';
import { buildApp } from '../app';
import { decryptJson, encryptJson, isEncryptedValue } from '../services/crypto';
import { Fixtures, bearer } from './helpers/fixtures';
import { MockS3, mockS3 } from './helpers/mockS3';

describe('crypto', () => {
  const key = Buffer.alloc(32, 3);

  it('round-trips values', () => {
    const value = { accessKeyId: 'AKIA123', secretAccessKey: 's3cr3t' };
    expect(decryptJson(encryptJson(value, key), key)).toEqual(value);
  });

  it('rejects a wrong key and tampered ciphertext', () => {
    const enc = encryptJson({ a: 1 }, key);
    expect(() => decryptJson(enc, Buffer.alloc(32, 4))).toThrow();
    expect(() => decryptJson({ ...enc, ct: Buffer.from('xx').toString('base64') }, key)).toThrow();
  });
});

describe('Workspace storage config', () => {
  let app: FastifyInstance;
  let fx: Fixtures;
  let slug: string;
  let workspaceId: string;
  let token: string;
  let s3: MockS3;

  const secret = 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY';

  beforeAll(async () => {
    s3 = await mockS3();
    app = await buildApp();
    await app.ready();
    fx = new Fixtures(app);
    const { workspace } = await fx.workspace();
    slug = workspace.slug;
    workspaceId = workspace.id;
    const admin = await fx.user();
    await fx.member(workspace.id, admin.id, 'admin');
    token = await fx.session(admin);
  });

  afterAll(async () => {
    await fx.cleanup();
    await app.close();
    await s3.close();
  });

  const save = (payload: object) =>
    app.inject({
      method: 'POST',
      url: `/api/workspaces/${slug}/storage`,
      headers: bearer(token),
      payload,
    });

  it('encrypts credentials at rest and never returns them', async () => {
    const res = await save({
      provider: 'S3',
      bucket: 'acme-mfe',
      region: 'eu-west-1',
      endpoint: s3.endpoint,
      credentials: { accessKeyId: 'AKIAEXAMPLE1234', secretAccessKey: secret },
    });
    expect(res.statusCode).toBe(200);
    expect(res.payload).not.toContain(secret);
    expect(res.json().storageConfig.maskedCredentials).toEqual({
      accessKeyId: '••••1234',
      secretAccessKey: '••••EKEY',
    });

    const row = await app.container.systemDb.workspaceStorageConfig.findUnique({
      where: { workspaceId },
    });
    expect(isEncryptedValue(row!.credentialsEncrypted)).toBe(true);
    expect(JSON.stringify(row!.credentialsEncrypted)).not.toContain(secret);

    const get = await app.inject({
      method: 'GET',
      url: `/api/workspaces/${slug}/storage`,
      headers: bearer(token),
    });
    expect(get.statusCode).toBe(200);
    expect(get.payload).not.toContain(secret);
  });

  it('keeps stored credentials when an update omits them', async () => {
    const res = await save({
      provider: 'S3',
      bucket: 'acme-mfe-v2',
      region: 'eu-west-1',
      endpoint: s3.endpoint,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().storageConfig).toMatchObject({
      bucket: 'acme-mfe-v2',
      maskedCredentials: { secretAccessKey: '••••EKEY' },
    });
  });

  it('rejects invalid input, including the non-isolatable local provider', async () => {
    expect((await save({ provider: 'LOCAL', bucket: 'x', region: 'y' })).statusCode).toBe(400);
    expect((await save({ provider: 'S3', bucket: '', region: 'y' })).statusCode).toBe(400);
  });
});
