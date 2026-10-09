import { z } from 'zod';

// Secrets that have shipped in examples, charts or code. Never acceptable in production.
const KNOWN_DEFAULT_SECRETS = new Set([
  'changeme',
  'super-secret-jwt-key-change-me',
  'super-secret-key-for-development-only',
]);

const DEV_JWT_SECRET = 'harmoniq-dev-only-jwt-secret-do-not-use-in-production';
// 32 zero-ish bytes, base64. Only ever used outside production.
const DEV_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(4000),
  JWT_SECRET: z.string().optional(),
  HARMONIQ_ENCRYPTION_KEY: z.string().optional(),
  WEB_ORIGIN: z.string().url().default('http://localhost:3000'),
  CACHE_ADAPTER: z.string().default('memory'),
  REDIS_URL: z.string().optional(),
  HARMONIQ_SETUP_TOKEN: z.string().optional(),
  HARMONIQ_GC_KEEP_VERSIONS: z.coerce.number().int().min(1).default(10),
  GITHUB_CLIENT_ID: z.string().optional(),
  GITHUB_CLIENT_SECRET: z.string().optional(),
  HARMONIQ_DEV_LOGIN: z.string().optional(),
  HARMONIQ_VALIDATE_BUNDLES: z.string().optional(),
  SMTP_URL: z.string().optional(),
  MAIL_FROM: z.string().default('Harmoniq <no-reply@harmoniq.local>'),
  HARMONIQ_MANIFEST_RATE_LIMIT: z.coerce.number().int().positive().default(600),
});

export interface Config {
  nodeEnv: 'development' | 'test' | 'production';
  isProduction: boolean;
  port: number;
  jwtSecret: string;
  /** Raw 32-byte key for AES-256-GCM. */
  encryptionKey: Buffer;
  webOrigin: string;
  cacheAdapter: 'redis' | 'memory';
  redisUrl?: string;
  setupToken?: string;
  /** Newest versions kept per module+environment regardless of age, so rollback always works. */
  gcKeepVersions: number;
  github?: { clientId: string; clientSecret: string };
  /** Passwordless sign-in as any email. Development only; refused in production. */
  devLogin: boolean;
  /** Fetch and verify every bundle on deploy (dry runs always validate). */
  validateBundles: boolean;
  /** RL-01: manifest requests per minute per (workspace, client IP). */
  manifestRateLimit: number;
  /** Outbound email. Without SMTP in production, email sign-in is unavailable. */
  mail: { smtpUrl?: string; from: string };
}

export class ConfigError extends Error {}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    throw new ConfigError(`Invalid environment: ${parsed.error.message}`);
  }
  const e = parsed.data;
  const isProduction = e.NODE_ENV === 'production';

  let jwtSecret = e.JWT_SECRET;
  if (isProduction) {
    if (!jwtSecret || KNOWN_DEFAULT_SECRETS.has(jwtSecret) || jwtSecret.length < 32) {
      throw new ConfigError(
        'JWT_SECRET must be set to a random value of at least 32 characters in production'
      );
    }
  } else {
    jwtSecret ||= DEV_JWT_SECRET;
  }

  let encryptionKeyB64 = e.HARMONIQ_ENCRYPTION_KEY;
  if (!encryptionKeyB64) {
    if (isProduction) {
      throw new ConfigError(
        'HARMONIQ_ENCRYPTION_KEY must be set in production (32 random bytes, base64-encoded)'
      );
    }
    encryptionKeyB64 = DEV_ENCRYPTION_KEY;
  }
  const encryptionKey = Buffer.from(encryptionKeyB64, 'base64');
  if (encryptionKey.length !== 32) {
    throw new ConfigError('HARMONIQ_ENCRYPTION_KEY must decode to exactly 32 bytes');
  }

  const devLogin = e.HARMONIQ_DEV_LOGIN === '1' || e.HARMONIQ_DEV_LOGIN === 'true';
  if (devLogin && isProduction) {
    throw new ConfigError('HARMONIQ_DEV_LOGIN must not be enabled in production');
  }

  const cacheAdapter = e.CACHE_ADAPTER === 'redis' && e.REDIS_URL ? 'redis' : 'memory';

  return {
    nodeEnv: e.NODE_ENV,
    isProduction,
    port: e.PORT,
    jwtSecret,
    encryptionKey,
    webOrigin: e.WEB_ORIGIN,
    cacheAdapter,
    redisUrl: e.REDIS_URL,
    setupToken: e.HARMONIQ_SETUP_TOKEN,
    gcKeepVersions: e.HARMONIQ_GC_KEEP_VERSIONS,
    github:
      e.GITHUB_CLIENT_ID && e.GITHUB_CLIENT_SECRET
        ? { clientId: e.GITHUB_CLIENT_ID, clientSecret: e.GITHUB_CLIENT_SECRET }
        : undefined,
    devLogin,
    manifestRateLimit: e.HARMONIQ_MANIFEST_RATE_LIMIT,
    mail: { smtpUrl: e.SMTP_URL, from: e.MAIL_FROM },
    validateBundles: e.HARMONIQ_VALIDATE_BUNDLES === '1' || e.HARMONIQ_VALIDATE_BUNDLES === 'true',
  };
}
