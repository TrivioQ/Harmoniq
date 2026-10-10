import { z } from 'zod';
import {
  Plan,
  PlanFeature,
  PlanFeatureSchema,
  PlanSchema,
} from '@harmoniq/core/dist/schemas/AdminSchemas';

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
  STORAGE_ADAPTER: z.enum(['local', 's3', 'none']).optional(),
  LOCAL_STORAGE_DIR: z.string().default('./data/storage'),
  PUBLIC_URL: z.string().url().optional(),
  S3_BUCKET: z.string().optional(),
  S3_REGION: z.string().optional(),
  S3_ENDPOINT: z.string().url().optional(),
  S3_ACCESS_KEY_ID: z.string().optional(),
  S3_SECRET_ACCESS_KEY: z.string().optional(),
  S3_PUBLIC_URL: z.string().url().optional(),
  SMTP_URL: z.string().optional(),
  MAIL_FROM: z.string().default('Harmoniq <no-reply@harmoniq.local>'),
  HARMONIQ_MANIFEST_RATE_LIMIT: z.coerce.number().int().positive().default(600),
  HARMONIQ_MANIFEST_RATE_LIMIT_STARTUP: z.coerce.number().int().positive().default(3000),
  HARMONIQ_MANIFEST_RATE_LIMIT_ENTERPRISE: z.coerce.number().int().positive().default(10000),
  /** PLN-03: gate features by plan (hosted). Off: every plan has every feature (PLN-02). */
  HARMONIQ_PLAN_ENFORCEMENT: z.string().optional(),
  /** PLN-02: JSON `{ "hobby": ["approvals"], … }` replacing the features of those plans. */
  HARMONIQ_PLAN_FEATURES: z.string().optional(),
  TRUST_PROXY: z.string().optional(),
  OIDC_ISSUER: z.string().url().optional(),
  OIDC_CLIENT_ID: z.string().optional(),
  OIDC_CLIENT_SECRET: z.string().optional(),
  OIDC_DISPLAY_NAME: z.string().default('Single sign-on'),
  HARMONIQ_SSO_ALLOW_PRIVATE_ISSUERS: z.string().optional(),
});

export interface Config {
  nodeEnv: 'development' | 'test' | 'production';
  isProduction: boolean;
  /**
   * Which peers may set X-Forwarded-For (Fastify `trustProxy`). Per-IP rate limits and
   * audit IPs use the client address it yields, e.g. the browser behind the dashboard
   * or a load balancer.
   */
  trustProxy: boolean | string;
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
  /** SSO-03: instance-wide OIDC sign-in from env vars (provider id `oidc`). */
  oidc?: { issuer: string; clientId: string; clientSecret: string; displayName: string };
  /** Workspace OIDC issuers may be private / http (self-hosted IdPs on internal networks). */
  ssoAllowPrivateIssuers: boolean;
  /** Passwordless sign-in as any email. Development only; refused in production. */
  devLogin: boolean;
  /** Fetch and verify every bundle on deploy (dry runs always validate). */
  validateBundles: boolean;
  /** RL-01: manifest requests per minute per (workspace, client IP). */
  /** RL-01/04: manifest requests per minute per (workspace, IP), by plan. */
  manifestRateLimit: number;
  manifestRateLimits: Record<Plan, number>;
  /** PLN-02/03: enforce plan features; the feature matrix (overridable). */
  plans: { enforced: boolean; features: Record<Plan, PlanFeature[]> };
  /** Outbound email. Without SMTP in production, email sign-in is unavailable. */
  mail: { smtpUrl?: string; from: string };
  /** Where the `local` storage adapter keeps objects (also when chosen in the admin panel). */
  localStorageDir: string;
  /** Public base URL of this registry (links to /static objects). */
  publicUrl: string;
  /**
   * Instance default storage for published manifests (and bundles without a workspace
   * bucket). `none` disables publishing for workspaces without their own bucket.
   */
  storage:
    | { adapter: 'none' }
    | { adapter: 'local'; dir: string }
    | {
        adapter: 's3';
        bucket: string;
        region: string;
        endpoint?: string;
        /** Omit both to use the AWS default credential chain (e.g. an ECS task role). */
        accessKeyId?: string;
        secretAccessKey?: string;
        /** CDN/public base URL for objects in the bucket. */
        publicUrl?: string;
      };
}

export class ConfigError extends Error {}

/** PLN-03 defaults: BYOB-01 (startup+), SSO-24 (SCIM, enterprise). */
export const DEFAULT_PLAN_FEATURES: Record<Plan, PlanFeature[]> = {
  hobby: [],
  startup: ['byob', 'approvals'],
  enterprise: ['byob', 'approvals', 'saml', 'scim'],
};

function planFeatures(json: string | undefined): Record<Plan, PlanFeature[]> {
  if (!json) return DEFAULT_PLAN_FEATURES;
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new ConfigError('HARMONIQ_PLAN_FEATURES must be JSON, e.g. {"hobby":["approvals"]}');
  }
  const result = z.record(PlanSchema, z.array(PlanFeatureSchema)).safeParse(parsed);
  if (!result.success) {
    throw new ConfigError(`HARMONIQ_PLAN_FEATURES: ${result.error.issues[0].message}`);
  }
  return { ...DEFAULT_PLAN_FEATURES, ...result.data };
}

function resolveStorage(e: z.infer<typeof EnvSchema>, isProduction: boolean): Config['storage'] {
  // Local disk by default in development; production must choose explicitly.
  const adapter = e.STORAGE_ADAPTER ?? (isProduction ? 'none' : 'local');
  if (adapter === 'local') return { adapter, dir: e.LOCAL_STORAGE_DIR };
  if (adapter === 's3') {
    if (!e.S3_BUCKET || !e.S3_REGION) {
      throw new ConfigError('STORAGE_ADAPTER=s3 requires S3_BUCKET and S3_REGION');
    }
    if (!!e.S3_ACCESS_KEY_ID !== !!e.S3_SECRET_ACCESS_KEY) {
      throw new ConfigError('Set both S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY, or neither');
    }
    return {
      adapter,
      bucket: e.S3_BUCKET,
      region: e.S3_REGION,
      endpoint: e.S3_ENDPOINT,
      accessKeyId: e.S3_ACCESS_KEY_ID,
      secretAccessKey: e.S3_SECRET_ACCESS_KEY,
      publicUrl: e.S3_PUBLIC_URL?.replace(/\/$/, ''),
    };
  }
  return { adapter: 'none' };
}

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

  // Default: proxies on private networks (the dashboard, a load balancer in the VPC).
  const trustProxy =
    e.TRUST_PROXY === undefined
      ? 'loopback,linklocal,uniquelocal'
      : e.TRUST_PROXY === 'true'
        ? true
        : e.TRUST_PROXY === 'false'
          ? false
          : e.TRUST_PROXY;

  return {
    nodeEnv: e.NODE_ENV,
    isProduction,
    trustProxy,
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
    manifestRateLimits: {
      hobby: e.HARMONIQ_MANIFEST_RATE_LIMIT,
      startup: e.HARMONIQ_MANIFEST_RATE_LIMIT_STARTUP,
      enterprise: e.HARMONIQ_MANIFEST_RATE_LIMIT_ENTERPRISE,
    },
    plans: {
      enforced: e.HARMONIQ_PLAN_ENFORCEMENT === '1' || e.HARMONIQ_PLAN_ENFORCEMENT === 'true',
      features: planFeatures(e.HARMONIQ_PLAN_FEATURES),
    },
    oidc:
      e.OIDC_ISSUER && e.OIDC_CLIENT_ID && e.OIDC_CLIENT_SECRET
        ? {
            issuer: e.OIDC_ISSUER,
            clientId: e.OIDC_CLIENT_ID,
            clientSecret: e.OIDC_CLIENT_SECRET,
            displayName: e.OIDC_DISPLAY_NAME,
          }
        : undefined,
    ssoAllowPrivateIssuers:
      !isProduction ||
      e.HARMONIQ_SSO_ALLOW_PRIVATE_ISSUERS === '1' ||
      e.HARMONIQ_SSO_ALLOW_PRIVATE_ISSUERS === 'true',
    mail: { smtpUrl: e.SMTP_URL, from: e.MAIL_FROM },
    localStorageDir: e.LOCAL_STORAGE_DIR,
    publicUrl: (e.PUBLIC_URL ?? `http://localhost:${e.PORT}`).replace(/\/$/, ''),
    storage: resolveStorage(e, isProduction),
    validateBundles: e.HARMONIQ_VALIDATE_BUNDLES === '1' || e.HARMONIQ_VALIDATE_BUNDLES === 'true',
  };
}
