import { describe, it, expect } from 'vitest';
import { loadConfig, ConfigError } from '../config';

const strongSecret = 'x'.repeat(48);
const validKey = Buffer.alloc(32, 1).toString('base64');

describe('loadConfig', () => {
  it('falls back to dev secrets outside production', () => {
    const config = loadConfig({ NODE_ENV: 'development' });
    expect(config.jwtSecret).toBeTruthy();
    expect(config.encryptionKey).toHaveLength(32);
    expect(config.port).toBe(4000);
  });

  it.each([
    ['missing', undefined],
    ['a known default', 'changeme'],
    ['too short', 'short-secret'],
  ])('refuses to start in production when JWT_SECRET is %s', (_label, secret) => {
    expect(() =>
      loadConfig({
        NODE_ENV: 'production',
        JWT_SECRET: secret,
        HARMONIQ_ENCRYPTION_KEY: validKey,
      })
    ).toThrow(ConfigError);
  });

  it('refuses to start in production without an encryption key', () => {
    expect(() => loadConfig({ NODE_ENV: 'production', JWT_SECRET: strongSecret })).toThrow(
      /HARMONIQ_ENCRYPTION_KEY/
    );
  });

  it('rejects an encryption key that is not 32 bytes', () => {
    expect(() =>
      loadConfig({ NODE_ENV: 'development', HARMONIQ_ENCRYPTION_KEY: 'dG9vLXNob3J0' })
    ).toThrow(/32 bytes/);
  });

  it('accepts a strong production configuration', () => {
    const config = loadConfig({
      NODE_ENV: 'production',
      JWT_SECRET: strongSecret,
      HARMONIQ_ENCRYPTION_KEY: validKey,
    });
    expect(config.isProduction).toBe(true);
  });

  it('only selects redis when a URL is provided', () => {
    expect(loadConfig({ CACHE_ADAPTER: 'redis' }).cacheAdapter).toBe('memory');
    expect(
      loadConfig({ CACHE_ADAPTER: 'redis', REDIS_URL: 'redis://localhost:6380' }).cacheAdapter
    ).toBe('redis');
  });
});

describe('instance storage config', () => {
  it('accepts S3 without static keys (task role) but not half a key pair', () => {
    expect(
      loadConfig({ STORAGE_ADAPTER: 's3', S3_BUCKET: 'b', S3_REGION: 'eu-west-1' }).storage
    ).toMatchObject({
      adapter: 's3',
      bucket: 'b',
    });
    expect(() =>
      loadConfig({
        STORAGE_ADAPTER: 's3',
        S3_BUCKET: 'b',
        S3_REGION: 'eu-west-1',
        S3_ACCESS_KEY_ID: 'x',
      })
    ).toThrow(ConfigError);
  });

  it('defaults to local storage in development and none in production', () => {
    expect(loadConfig({}).storage.adapter).toBe('local');
    expect(
      loadConfig({
        NODE_ENV: 'production',
        JWT_SECRET: 'x'.repeat(48),
        HARMONIQ_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString('base64'),
      }).storage.adapter
    ).toBe('none');
  });
});
