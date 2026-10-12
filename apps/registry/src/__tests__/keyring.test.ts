// Copyright The Harmoniq Authors
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createCipheriv, randomBytes } from 'crypto';
import { FastifyInstance } from 'fastify';
import { buildApp } from '../app';
import { loadConfig } from '../config';
import {
  decryptJson,
  encryptJson,
  keyId,
  openSecret,
  registerKeyring,
  resealDeep,
  sealSecret,
  sealedKeyId,
} from '../services/crypto';
import { resealAll, sealedValueReport } from '../services/reseal';
import { Fixtures, bearer } from './helpers/fixtures';

/** An envelope as written before key ids (no `kid`). */
function legacySeal(plain: string, key: Buffer) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(JSON.stringify(plain), 'utf8'), cipher.final()]);
  const envelope = {
    v: 1,
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    ct: ct.toString('base64'),
  };
  return 'enc:v1:' + Buffer.from(JSON.stringify(envelope)).toString('base64');
}

describe('Encryption keyring (INST-26)', () => {
  const oldKey = randomBytes(32);
  const newKey = randomBytes(32);

  it('opens legacy and new values, rotates, and fails closed on an unknown key', () => {
    const legacy = legacySeal('s3cret', oldKey);
    expect(sealedKeyId(legacy)).toBeNull();
    expect(openSecret(legacy, oldKey)).toBe('s3cret');

    const sealedOld = sealSecret('s3cret', oldKey);
    expect(sealedKeyId(sealedOld)).toBe(keyId(oldKey));

    // Rotate: the new key seals, the old one still opens.
    registerKeyring({
      active: newKey,
      keys: new Map([
        [keyId(newKey), { key: newKey, label: 'new' }],
        [keyId(oldKey), { key: oldKey, label: 'old' }],
      ]),
    });
    expect(openSecret(sealedOld, newKey)).toBe('s3cret');
    expect(openSecret(legacy, newKey)).toBe('s3cret');
    expect(sealedKeyId(sealSecret('x', newKey))).toBe(keyId(newKey));
    expect(encryptJson({ a: 1 }, newKey).kid).toBe(keyId(newKey));

    // Re-sealing moves values (inside JSON too) to the new key, once.
    const config = {
      clientSecret: sealedOld,
      nested: { env: encryptJson('x', oldKey) },
      plain: 'p',
    };
    const first = resealDeep(config, newKey);
    expect(first.changed).toBe(2);
    const moved = first.value as typeof config;
    expect(sealedKeyId(moved.clientSecret)).toBe(keyId(newKey));
    expect(openSecret(moved.clientSecret, newKey)).toBe('s3cret');
    expect(decryptJson(moved.nested.env, newKey)).toBe('x');
    expect(moved.plain).toBe('p');
    expect(resealDeep(moved, newKey).changed).toBe(0);

    // A key that is not configured: no fallback, no guessing.
    const stranger = randomBytes(32);
    expect(() => openSecret(sealSecret('x', stranger), newKey)).toThrow(/No encryption key/);
  });

  it('reads the keyring from HARMONIQ_ENCRYPTION_KEYS', () => {
    const a = randomBytes(32).toString('base64');
    const b = randomBytes(32).toString('base64');
    const config = loadConfig({
      ...process.env,
      NODE_ENV: 'test',
      HARMONIQ_ENCRYPTION_KEYS: `2026:${a}, 2025:${b}`,
    });
    expect(config.encryptionKey.equals(Buffer.from(a, 'base64'))).toBe(true);
    expect(openSecret(sealSecret('x', Buffer.from(b, 'base64')), config.encryptionKey)).toBe('x');
    expect(() =>
      loadConfig({ ...process.env, HARMONIQ_ENCRYPTION_KEYS: 'bad:dG9vc2hvcnQ=' })
    ).toThrow(/32 bytes/);
  });
});

describe('Re-sealing stored values (INST-26)', () => {
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

  it('re-seals legacy values with the active key, idempotently, and reports by key', async () => {
    const key = app.config.encryptionKey;
    const { workspace } = await fx.workspace();
    const endpoint = await app.container.systemDb.webhookEndpoint.create({
      data: {
        workspaceId: workspace.id,
        url: 'https://8.8.8.8/h',
        events: ['*'],
        secret: legacySeal('whsec_legacy', key),
      },
    });
    const before = await sealedValueReport(app.container.systemDb, key);
    expect(before.legacy).toBeGreaterThanOrEqual(1);

    const first = await resealAll(app.container.systemDb, key);
    expect(first.byModel.webhookEndpoint).toBeGreaterThanOrEqual(1);
    const row = await app.container.systemDb.webhookEndpoint.findUniqueOrThrow({
      where: { id: endpoint.id },
    });
    expect(sealedKeyId(row.secret)).toBe(keyId(key));
    expect(openSecret(row.secret, key)).toBe('whsec_legacy');

    expect((await resealAll(app.container.systemDb, key)).resealed).toBe(0);
    const after = await sealedValueReport(app.container.systemDb, key);
    expect(after).toMatchObject({ legacy: 0, stale: 0, active: keyId(key) });
  });

  it('shows the keys to instance admins and re-seals on request', async () => {
    const root = await fx.session(await fx.user({ instanceAdmin: true }));
    const report = await app.inject({
      method: 'GET',
      url: '/api/admin/encryption',
      headers: bearer(root),
    });
    expect(report.statusCode).toBe(200);
    expect(report.json().keys[0]).toMatchObject({ active: true });
    const reseal = await app.inject({
      method: 'POST',
      url: '/api/admin/encryption/reseal',
      headers: bearer(root),
    });
    expect(reseal.json()).toMatchObject({ queued: false, resealed: 0 });
    const health = await app.inject({
      method: 'GET',
      url: '/api/admin/health',
      headers: bearer(root),
    });
    expect(health.json().encryption).toMatchObject({ stale: 0, unknownKeys: 0 });
  });
});
