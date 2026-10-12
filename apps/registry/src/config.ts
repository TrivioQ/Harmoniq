// Copyright The Harmoniq Authors
// SPDX-License-Identifier: Apache-2.0

import { z } from 'zod';
import {
  Plan,
  PlanFeature,
  PlanFeatureSchema,
  PlanLimits,
  PlanLimitsByPlanSchema,
  PlanSchema,
} from '@harmoniq/core/dist/schemas/AdminSchemas';
import { keyId, registerKeyring } from './services/crypto';

// Secrets that have shipped in examples, charts or code. Never acceptable in production.
const KNOWN_DEFAULT_SECRETS = new Set([
  'changeme',
  'super-secret-jwt-key-change-me',
  'super-secret-key-for-development-only',
]);

/**
 * Sign-in methods `HARMONIQ_AUTH_METHODS` can allow. `oidc` is the instance IdP from the
 * `OIDC_*` variables; `sso-oidc` and `sso-saml` are the single sign-on that workspaces
 * and organizations configure themselves.
 */
export const AUTH_METHODS = ['github', 'email', 'oidc', 'sso-oidc', 'sso-saml', 'dev'] as const;
export type AuthMethod = (typeof AUTH_METHODS)[number];

const DEV_JWT_SECRET = 'harmoniq-dev-only-jwt-secret-do-not-use-in-production';
// 32 zero-ish bytes, base64. Only ever used outside production.
const DEV_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(4000),
  JWT_SECRET: z.string().optional(),
  HARMONIQ_ENCRYPTION_KEY: z.string().optional(),
  HARMONIQ_ENCRYPTION_KEYS: z.string().optional(),
  WEB_ORIGIN: z.string().url().default('http://localhost:3000'),
  CACHE_ADAPTER: z.string().default('memory'),
  REDIS_URL: z.string().optional(),
  HARMONIQ_SETUP_TOKEN: z.string().optional(),
  // Empty (as in .env.example) means unset.
  HARMONIQ_METRICS_TOKEN: z.preprocess(
    (v) => (v === '' ? undefined : v),
    z.string().min(16, 'HARMONIQ_METRICS_TOKEN must be at least 16 characters').optional()
  ),
  HARMONIQ_METRICS_TENANT_LABELS: z.string().optional(),
  HARMONIQ_METRICS_PORT: z.preprocess(
    (v) => (v === '' ? undefined : v),
    z.coerce.number().int().min(0).max(65_535).optional()
  ),
  HARMONIQ_GC_KEEP_VERSIONS: z.coerce.number().int().min(1).default(10),
  HARMONIQ_DOMAIN_GRACE_DAYS: z.coerce.number().int().min(0).max(365).default(30),
  HARMONIQ_AUDIT_RETENTION_DAYS: z.coerce.number().int().min(1).default(400),
  HARMONIQ_TENANT_RESTORE_DAYS: z.coerce.number().int().min(0).max(365).default(30),
  GITHUB_CLIENT_ID: z.string().optional(),
  GITHUB_CLIENT_SECRET: z.string().optional(),
  HARMONIQ_DEV_LOGIN: z.string().optional(),
  HARMONIQ_AUTH_METHODS: z.string().optional(),
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
  HARMONIQ_WRITE_RATE_LIMIT: z.coerce.number().int().positive().default(300),
  HARMONIQ_MANIFEST_MISS_LIMIT: z.coerce.number().int().positive().default(120),
  TLS_CERT_FILE: z.string().optional(),
  TLS_KEY_FILE: z.string().optional(),
  /** PLN-03: gate features by plan (hosted). Off: every plan has every feature (PLN-02). */
  HARMONIQ_PLAN_ENFORCEMENT: z.string().optional(),
  /** PLN-02: JSON `{ "hobby": ["approvals"], … }` replacing the features of those plans. */
  HARMONIQ_PLAN_FEATURES: z.string().optional(),
  /** PLN-04: quotas by plan, JSON. */
  HARMONIQ_PLAN_LIMITS: z.string().optional(),
  /** MT-12: per-tenant budgets (per minute); the per-credential write limit still applies. */
  HARMONIQ_API_RATE_LIMIT: z.coerce.number().int().positive().default(1200),
  HARMONIQ_API_RATE_LIMIT_STARTUP: z.coerce.number().int().positive().default(6000),
  HARMONIQ_API_RATE_LIMIT_ENTERPRISE: z.coerce.number().int().positive().default(30000),
  HARMONIQ_DEPLOY_RATE_LIMIT: z.coerce.number().int().positive().default(30),
  HARMONIQ_DEPLOY_RATE_LIMIT_STARTUP: z.coerce.number().int().positive().default(120),
  HARMONIQ_DEPLOY_RATE_LIMIT_ENTERPRISE: z.coerce.number().int().positive().default(600),
  HARMONIQ_HEALTH_RATE_LIMIT: z.coerce.number().int().positive().default(6000),
  HARMONIQ_HEALTH_RATE_LIMIT_STARTUP: z.coerce.number().int().positive().default(30000),
  HARMONIQ_HEALTH_RATE_LIMIT_ENTERPRISE: z.coerce.number().int().positive().default(120000),
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
  /**
   * The active 32-byte AES-256-GCM key; its keyring (INST-26, `keyringOf`) opens values
   * sealed with older keys.
   */
  encryptionKey: Buffer;
  webOrigin: string;
  cacheAdapter: 'redis' | 'memory';
  redisUrl?: string;
  setupToken?: string;
  /**
   * INST-25: `/metrics` requires `Authorization: Bearer <token>` when set. Workspace slugs
   * appear as metric labels only with `tenantLabels` (they name the instance's tenants).
   * With `port`, metrics are served on that port only, not on the API port.
   */
  metrics: { token?: string; tenantLabels: boolean; port?: number };
  /** Newest versions kept per module+environment regardless of age, so rollback always works. */
  gcKeepVersions: number;
  /**
   * DOM-04: days after the first start with domain verification during which unverified
   * trusted domains still work for SSO sign-in (never for discovery). 0 enforces at once.
   */
  domainGraceDays: number;
  /** AUD-05: days a deleted workspace's audit events are kept (counted from each event). */
  auditRetentionDays: number;
  /** TLC-02: days a deleted workspace or organization can be restored; 0 purges at once. */
  tenantRestoreDays: number;
  github?: { clientId: string; clientSecret: string };
  /** SSO-03: instance-wide OIDC sign-in from env vars (provider id `oidc`). */
  oidc?: { issuer: string; clientId: string; clientSecret: string; displayName: string };
  /** Workspace OIDC issuers may be private / http (self-hosted IdPs on internal networks). */
  ssoAllowPrivateIssuers: boolean;
  /** Passwordless sign-in as any email. Development only; refused in production. */
  devLogin: boolean;
  /**
   * Sign-in methods the environment allows. The admin panel can turn allowed methods
   * off but never on beyond this. `fromEnvironment` is false when `HARMONIQ_AUTH_METHODS`
   * is unset: then every method except `dev` is allowed, and `dev` follows
   * `HARMONIQ_DEV_LOGIN`.
   */
  authMethods: { allowed: AuthMethod[]; fromEnvironment: boolean };
  /** Fetch and verify every bundle on deploy (dry runs always validate). */
  validateBundles: boolean;
  /** RL-01: manifest requests per minute per (workspace, client IP). */
  /** RL-01/04: manifest requests per minute per (workspace, IP), by plan. */
  manifestRateLimit: number;
  manifestRateLimits: Record<Plan, number>;
  /**
   * Not-found manifest responses per minute per client IP, across all workspaces. Limits
   * that are keyed by workspace can't stop requests that invent a new slug every time.
   */
  manifestMissLimit: number;
  /** Writes (POST/PUT/PATCH/DELETE) per minute per credential (or IP), unless a route sets its own. */
  writeRateLimit: number;
  /** HTTP/2 over TLS (HTTP/1.1 still accepted) when both files are set. */
  tls?: { certFile: string; keyFile: string };
  /** PLN-02/03: enforce plan features; the feature matrix (overridable). */
  plans: {
    enforced: boolean;
    features: Record<Plan, PlanFeature[]>;
    limits: Record<Plan, PlanLimits>;
  };
  /** MT-12: management API writes per minute, per workspace or organization, by plan. */
  apiRateLimits: Record<Plan, number>;
  /** MT-12: deploys per minute per workspace, by plan. */
  deployRateLimits: Record<Plan, number>;
  /** MT-12: health reports per minute per workspace, by plan. */
  healthRateLimits: Record<Plan, number>;
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

/** PLN-04 defaults; `null` is unlimited. Without plan enforcement nothing is limited. */
export const DEFAULT_PLAN_LIMITS: Record<Plan, PlanLimits> = {
  hobby: {
    workspaces: 3,
    members: 5,
    modules: 20,
    environmentsPerHostApp: 5,
    storageGb: 1,
    deploysPerMonth: 500,
    webhooks: 5,
  },
  startup: {
    workspaces: 20,
    members: 50,
    modules: 200,
    environmentsPerHostApp: 20,
    storageGb: 50,
    deploysPerMonth: 10_000,
    webhooks: 25,
  },
  enterprise: {
    workspaces: null,
    members: null,
    modules: null,
    environmentsPerHostApp: null,
    storageGb: null,
    deploysPerMonth: null,
    webhooks: null,
  },
};

/** `HARMONIQ_PLAN_LIMITS`: JSON by plan, merged over the defaults per quota. */
function planLimits(json: string | undefined): Record<Plan, PlanLimits> {
  if (!json) return DEFAULT_PLAN_LIMITS;
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new ConfigError('HARMONIQ_PLAN_LIMITS must be JSON, e.g. {"hobby":{"members":10}}');
  }
  const result = PlanLimitsByPlanSchema.safeParse(parsed);
  if (!result.success) {
    throw new ConfigError(`HARMONIQ_PLAN_LIMITS: ${result.error.issues[0].message}`);
  }
  return Object.fromEntries(
    (Object.keys(DEFAULT_PLAN_LIMITS) as Plan[]).map((plan) => [
      plan,
      { ...DEFAULT_PLAN_LIMITS[plan], ...(result.data[plan] ?? {}) },
    ])
  ) as Record<Plan, PlanLimits>;
}

/** `HARMONIQ_AUTH_METHODS`: a comma-separated allowlist; unset or blank keeps the defaults. */
export function parseAuthMethods(
  raw: string | undefined,
  devLoginFlag: boolean
): Config['authMethods'] {
  if (raw === undefined || raw.trim() === '') {
    const allowed = AUTH_METHODS.filter((m) => m !== 'dev' || devLoginFlag);
    return { allowed, fromEnvironment: false };
  }
  const tokens = raw
    .split(',')
    .map((t) => t.trim().toLowerCase())
    .filter(Boolean);
  const unknown = tokens.filter((t) => !(AUTH_METHODS as readonly string[]).includes(t));
  if (unknown.length) {
    throw new ConfigError(
      `HARMONIQ_AUTH_METHODS: unknown method ${unknown.map((u) => `"${u}"`).join(', ')}; use ${AUTH_METHODS.join(', ')}`
    );
  }
  if (!tokens.length) {
    throw new ConfigError('HARMONIQ_AUTH_METHODS must name at least one sign-in method');
  }
  const allowed = AUTH_METHODS.filter((m) => tokens.includes(m));
  if (devLoginFlag && !allowed.includes('dev')) {
    throw new ConfigError(
      'HARMONIQ_DEV_LOGIN is on but HARMONIQ_AUTH_METHODS does not list "dev"; add it or unset HARMONIQ_DEV_LOGIN'
    );
  }
  return { allowed, fromEnvironment: true };
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

  // INST-26: `HARMONIQ_ENCRYPTION_KEYS=label:base64,…` (the first seals new values; the
  // others still open old ones), or the single-key `HARMONIQ_ENCRYPTION_KEY`.
  const listed = (e.HARMONIQ_ENCRYPTION_KEYS ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry, i) => {
      const at = entry.indexOf(':');
      return at > 0
        ? { label: entry.slice(0, at), b64: entry.slice(at + 1) }
        : { label: `key${i + 1}`, b64: entry };
    });
  if (!listed.length) {
    let single = e.HARMONIQ_ENCRYPTION_KEY;
    if (!single) {
      if (isProduction) {
        throw new ConfigError(
          'HARMONIQ_ENCRYPTION_KEY must be set in production (32 random bytes, base64-encoded)'
        );
      }
      single = DEV_ENCRYPTION_KEY;
    }
    listed.push({ label: 'default', b64: single });
  } else if (e.HARMONIQ_ENCRYPTION_KEY) {
    // Values sealed with the single key keep opening after the switch to a list.
    listed.push({ label: 'previous', b64: e.HARMONIQ_ENCRYPTION_KEY });
  }
  const ring = new Map<string, { key: Buffer; label: string }>();
  for (const { label, b64 } of listed) {
    const key = Buffer.from(b64, 'base64');
    if (key.length !== 32) {
      throw new ConfigError(`Encryption key "${label}" must decode to exactly 32 bytes`);
    }
    if (!ring.has(keyId(key))) ring.set(keyId(key), { key, label });
  }
  const encryptionKey = [...ring.values()][0].key;
  registerKeyring({ active: encryptionKey, keys: ring });

  const devLoginFlag = e.HARMONIQ_DEV_LOGIN === '1' || e.HARMONIQ_DEV_LOGIN === 'true';
  const authMethods = parseAuthMethods(e.HARMONIQ_AUTH_METHODS, devLoginFlag);
  const devLogin = authMethods.allowed.includes('dev');
  if (devLogin && isProduction) {
    throw new ConfigError(
      'Development login must not be enabled in production (HARMONIQ_DEV_LOGIN or "dev" in HARMONIQ_AUTH_METHODS)'
    );
  }

  if (!!e.TLS_CERT_FILE !== !!e.TLS_KEY_FILE) {
    throw new ConfigError('Set both TLS_CERT_FILE and TLS_KEY_FILE, or neither');
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
    metrics: {
      token: e.HARMONIQ_METRICS_TOKEN,
      tenantLabels:
        e.HARMONIQ_METRICS_TENANT_LABELS === '1' || e.HARMONIQ_METRICS_TENANT_LABELS === 'true',
      port: e.HARMONIQ_METRICS_PORT,
    },
    gcKeepVersions: e.HARMONIQ_GC_KEEP_VERSIONS,
    domainGraceDays: e.HARMONIQ_DOMAIN_GRACE_DAYS,
    auditRetentionDays: e.HARMONIQ_AUDIT_RETENTION_DAYS,
    tenantRestoreDays: e.HARMONIQ_TENANT_RESTORE_DAYS,
    github:
      e.GITHUB_CLIENT_ID && e.GITHUB_CLIENT_SECRET
        ? { clientId: e.GITHUB_CLIENT_ID, clientSecret: e.GITHUB_CLIENT_SECRET }
        : undefined,
    devLogin,
    authMethods,
    manifestRateLimit: e.HARMONIQ_MANIFEST_RATE_LIMIT,
    writeRateLimit: e.HARMONIQ_WRITE_RATE_LIMIT,
    manifestMissLimit: e.HARMONIQ_MANIFEST_MISS_LIMIT,
    tls:
      e.TLS_CERT_FILE && e.TLS_KEY_FILE
        ? { certFile: e.TLS_CERT_FILE, keyFile: e.TLS_KEY_FILE }
        : undefined,
    manifestRateLimits: {
      hobby: e.HARMONIQ_MANIFEST_RATE_LIMIT,
      startup: e.HARMONIQ_MANIFEST_RATE_LIMIT_STARTUP,
      enterprise: e.HARMONIQ_MANIFEST_RATE_LIMIT_ENTERPRISE,
    },
    plans: {
      enforced: e.HARMONIQ_PLAN_ENFORCEMENT === '1' || e.HARMONIQ_PLAN_ENFORCEMENT === 'true',
      features: planFeatures(e.HARMONIQ_PLAN_FEATURES),
      limits: planLimits(e.HARMONIQ_PLAN_LIMITS),
    },
    apiRateLimits: {
      hobby: e.HARMONIQ_API_RATE_LIMIT,
      startup: e.HARMONIQ_API_RATE_LIMIT_STARTUP,
      enterprise: e.HARMONIQ_API_RATE_LIMIT_ENTERPRISE,
    },
    deployRateLimits: {
      hobby: e.HARMONIQ_DEPLOY_RATE_LIMIT,
      startup: e.HARMONIQ_DEPLOY_RATE_LIMIT_STARTUP,
      enterprise: e.HARMONIQ_DEPLOY_RATE_LIMIT_ENTERPRISE,
    },
    healthRateLimits: {
      hobby: e.HARMONIQ_HEALTH_RATE_LIMIT,
      startup: e.HARMONIQ_HEALTH_RATE_LIMIT_STARTUP,
      enterprise: e.HARMONIQ_HEALTH_RATE_LIMIT_ENTERPRISE,
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
