// Copyright The Harmoniq Authors
// SPDX-License-Identifier: Apache-2.0

import { z } from 'zod';
import { PlanFeatureSchema, PlanLimitsSchema } from './AdminSchemas';

// INST-11..17: instance settings kept in the database (secrets sealed). They take
// precedence over the environment, which only provides the defaults. Secrets are
// write-only: omit them on update to keep the stored value.

const httpsUrl = z
  .string()
  .url()
  .refine((u) => /^https?:\/\//.test(u), 'An http(s) URL');

/** INST-11: the default storage for published manifests and bundles. */
export const StorageSettingsSchema = z.discriminatedUnion('adapter', [
  z.object({ adapter: z.literal('none') }),
  /** The registry's disk (LOCAL_STORAGE_DIR), served at /static. Development only. */
  z.object({ adapter: z.literal('local') }),
  z.object({
    adapter: z.literal('s3'),
    bucket: z.string().min(3).max(63),
    region: z.string().min(1).max(50),
    endpoint: httpsUrl.optional(),
    accessKeyId: z.string().min(1).max(200).optional(),
    secretAccessKey: z.string().min(1).max(500).optional(),
    publicUrl: httpsUrl.optional(),
  }),
  z.object({
    adapter: z.literal('gcs'),
    bucket: z.string().min(3).max(222),
    projectId: z.string().min(1).max(100),
    clientEmail: z.string().email(),
    privateKey: z.string().min(1).max(10_000).optional(),
    publicUrl: httpsUrl.optional(),
  }),
  z.object({
    adapter: z.literal('azure'),
    /** Blob container. */
    container: z.string().min(3).max(63),
    connectionString: z.string().min(1).max(2000).optional(),
    publicUrl: httpsUrl.optional(),
  }),
]);
export type StorageSettings = z.infer<typeof StorageSettingsSchema>;

/** INST-12: outbound email. */
export const EmailSettingsSchema = z.object({
  host: z.string().min(1).max(255),
  port: z.number().int().min(1).max(65_535),
  /** `tls`: implicit TLS (465); `starttls`: upgrade (587); `none`: plain (local relays). */
  security: z.enum(['tls', 'starttls', 'none']).default('starttls'),
  username: z.string().max(255).optional(),
  password: z.string().max(1000).optional(),
  /** Sender, e.g. `Harmoniq <no-reply@example.com>`. */
  from: z.string().min(3).max(320),
});
export type EmailSettings = z.infer<typeof EmailSettingsSchema>;

/**
 * INST-13: sign-in methods for the whole instance. A disabled protocol can't be used by
 * any workspace or organization, whatever their own settings.
 */
export const AuthSettingsSchema = z.object({
  email: z.object({ enabled: z.boolean() }).default({ enabled: true }),
  github: z
    .object({
      enabled: z.boolean(),
      clientId: z.string().min(1).max(200).optional(),
      clientSecret: z.string().min(1).max(500).optional(),
    })
    .default({ enabled: true }),
  /** The instance OIDC provider and workspace / organization OIDC (Google included). */
  oidc: z.object({ enabled: z.boolean() }).default({ enabled: true }),
  /** Workspace / organization SAML. */
  saml: z.object({ enabled: z.boolean() }).default({ enabled: true }),
  /**
   * SES-01: a session ends `maxDays` after sign-in, or after `idleMinutes` without use
   * (null: no idle limit). Organization policy (POL-07) may only shorten them.
   */
  session: z
    .object({
      maxDays: z.number().int().min(1).max(365).default(30),
      idleMinutes: z
        .number()
        .int()
        .min(5)
        .max(60 * 24 * 90)
        .nullable()
        .default(null),
      /** INST-32: instance admins' sessions end sooner. */
      adminMaxHours: z
        .number()
        .int()
        .min(1)
        .max(24 * 30)
        .default(12),
    })
    .default({ maxDays: 30, idleMinutes: null, adminMaxHours: 12 }),
});
export type AuthSettings = z.infer<typeof AuthSettingsSchema>;

/** INST-14: shown in the dashboard header and in emails. */
export const BrandingSettingsSchema = z.object({
  name: z.string().trim().min(1).max(60),
  logoUrl: httpsUrl.optional(),
  supportUrl: httpsUrl.optional(),
  accentColor: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/, 'A colour like #4f46e5')
    .optional(),
});
export type BrandingSettings = z.infer<typeof BrandingSettingsSchema>;

/**
 * TLC-08: who may create organizations and standalone workspaces. Instance admins always
 * can; organization admins always create workspaces inside their organization.
 */
export const TenancySettingsSchema = z.object({
  creation: z.enum(['anyone', 'verified_domains', 'instance_admins']).default('anyone'),
  /** With `verified_domains`: these email domains too, besides domains a tenant verified. */
  allowedDomains: z
    .array(
      z
        .string()
        .trim()
        .toLowerCase()
        .regex(/^(?:[a-z0-9-]{1,63}\.)+[a-z]{2,63}$/, 'A domain such as example.com')
    )
    .max(100)
    .default([]),
});
export type TenancySettings = z.infer<typeof TenancySettingsSchema>;

// ─── INST-34: settings that used to come only from the environment ──────────
// Every field is optional: what isn't set keeps the environment's value.

const count = (max: number) => z.number().int().min(1).max(max);
const byPlan = <T extends z.ZodTypeAny>(value: T) =>
  z.object({ hobby: value.optional(), startup: value.optional(), enterprise: value.optional() });

/** PLN-02..05: enforcement, features and quotas per plan (over HARMONIQ_PLAN_*). */
export const PlansSettingsSchema = z.object({
  enforced: z.boolean().optional(),
  features: byPlan(z.array(PlanFeatureSchema)).optional(),
  limits: byPlan(PlanLimitsSchema).optional(),
});
export type PlansSettings = z.infer<typeof PlansSettingsSchema>;

/** RL-01..04, MT-12: per minute (over HARMONIQ_*_RATE_LIMIT*). */
export const RateLimitSettingsSchema = z.object({
  manifest: byPlan(count(1_000_000)).optional(),
  write: count(100_000).optional(),
  api: byPlan(count(1_000_000)).optional(),
  deploy: byPlan(count(100_000)).optional(),
  health: byPlan(count(10_000_000)).optional(),
});
export type RateLimitSettings = z.infer<typeof RateLimitSettingsSchema>;

/** GC-03/06, HLT: retention (over HARMONIQ_GC_KEEP_VERSIONS and the built-in defaults). */
export const GcSettingsSchema = z.object({
  keepVersions: count(1000).optional(),
  /** For new workspaces. */
  defaultRetentionDays: count(3650).optional(),
  healthEventRetentionHours: count(24 * 30).optional(),
  healthRollupRetentionDays: count(400).optional(),
});
export type GcSettings = z.infer<typeof GcSettingsSchema>;

/** VAL-02/03: validate bundles on every deploy (over HARMONIQ_VALIDATE_BUNDLES). */
export const BundleSettingsSchema = z.object({ validate: z.boolean().optional() });
export type BundleSettings = z.infer<typeof BundleSettingsSchema>;

export const INSTANCE_SETTING_KEYS = [
  'storage',
  'email',
  'auth',
  'branding',
  'tenancy',
  'plans',
  'rateLimits',
  'gc',
  'bundles',
] as const;
export type InstanceSettingKey = (typeof INSTANCE_SETTING_KEYS)[number];

export const InstanceSettingSchemas = {
  storage: StorageSettingsSchema,
  email: EmailSettingsSchema,
  auth: AuthSettingsSchema,
  branding: BrandingSettingsSchema,
  tenancy: TenancySettingsSchema,
  plans: PlansSettingsSchema,
  rateLimits: RateLimitSettingsSchema,
  gc: GcSettingsSchema,
  bundles: BundleSettingsSchema,
} as const;
