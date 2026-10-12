// Copyright The Harmoniq Authors
// SPDX-License-Identifier: Apache-2.0

import type { Prisma, PrismaClient } from '@prisma/client';
import type { ILogger } from '@harmoniq/core/dist/ports/ILogger';
import { BadRequestError } from '@harmoniq/core/dist/errors/AppError';
import type { IMailer } from '@harmoniq/core/dist/ports/IMailer';
import {
  AuthSettingsSchema,
  BrandingSettings,
  EmailSettings,
  InstanceSettingKey,
  InstanceSettingSchemas,
  INSTANCE_SETTING_KEYS,
  StorageSettings,
  TenancySettings,
  TenancySettingsSchema,
  PlansSettingsSchema,
  RateLimitSettingsSchema,
  GcSettingsSchema,
  BundleSettingsSchema,
} from '@harmoniq/core/dist/schemas/InstanceSettingsSchemas';
import type { Plan, PlanFeature, PlanLimits } from '@harmoniq/core/dist/schemas/AdminSchemas';
import YAML from 'yaml';
import type { AuthMethod, Config } from '../config';
import {
  StorageTarget,
  instanceStorageTarget,
  storageTargetFromSettings,
} from '../adapters/storage/createStorage';
import { SmtpMailer } from '../adapters/mail/SmtpMailer';
import { maskSecret, openSecret, sealSecret } from './crypto';

/** Write-only fields per setting, sealed at rest (INST-15). */
const SECRETS: Record<InstanceSettingKey, string[]> = {
  storage: ['secretAccessKey', 'privateKey', 'connectionString'],
  email: ['password'],
  auth: ['github.clientSecret'],
  branding: [],
  tenancy: [],
  plans: [],
  rateLimits: [],
  gc: [],
  bundles: [],
};

const RELOAD_MS = 60_000;
const rowKey = (key: InstanceSettingKey) => `settings.${key}`;

type Json = Record<string, unknown>;
const getPath = (obj: Json, path: string) =>
  path.split('.').reduce<unknown>((o, k) => (o as Json | undefined)?.[k], obj);
function setPath(obj: Json, path: string, value: unknown) {
  const keys = path.split('.');
  let o = obj;
  for (const k of keys.slice(0, -1)) o = (o[k] ??= {}) as Json;
  if (value === undefined) delete o[keys.at(-1)!];
  else o[keys.at(-1)!] = value;
}

export interface EffectiveAuth {
  email: boolean;
  github: { clientId: string; clientSecret: string } | null;
  /** The instance IdP from the `OIDC_*` variables (provider id `oidc`). */
  instanceOidc: boolean;
  /** OIDC that workspaces and organizations configure (`oidc:<ws>`, `org-oidc:<org>`). */
  oidc: boolean;
  /** SAML that workspaces and organizations configure. */
  saml: boolean;
  /** Development login (never in production). */
  dev: boolean;
}

/**
 * Which `HARMONIQ_AUTH_METHODS` entries each admin-panel switch maps to: the panel can
 * only turn a switch on when the environment allows at least one of them.
 */
export const AUTH_SETTING_METHODS: Record<'email' | 'github' | 'oidc' | 'saml', AuthMethod[]> = {
  email: ['email'],
  github: ['github'],
  oidc: ['oidc', 'sso-oidc'],
  saml: ['sso-saml'],
};

/** The method behind a session's provider id, e.g. `org-saml:acme` → `sso-saml`. */
export function methodOfProvider(provider: string): AuthMethod | null {
  if (provider === 'github' || provider === 'email' || provider === 'dev' || provider === 'oidc') {
    return provider;
  }
  const protocol = /^(?:org-)?(oidc|saml):/.exec(provider)?.[1];
  return protocol ? (`sso-${protocol}` as AuthMethod) : null;
}

/**
 * INST-11..17: instance settings. Rows in `InstanceConfig` (`settings.<key>`, secrets
 * sealed) take precedence over the environment, which only provides defaults. Every
 * replica reloads them every 60 seconds; a change made here applies at once.
 */
export class InstanceSettings {
  /** Stored values (secrets sealed), by key. */
  private rows: Partial<Record<InstanceSettingKey, Json>> = {};
  private snapshot = '';
  private version = 0;
  private derived: {
    version: number;
    storage?: StorageTarget | null;
    mailer?: IMailer | null;
  } = { version: -1 };
  private timer?: NodeJS.Timeout;
  private listeners: Array<() => void> = [];

  constructor(
    private deps: {
      systemDb: PrismaClient;
      config: Config;
      logger: ILogger;
      /** Used when nothing is configured outside production (development, tests). */
      fallbackMailer: IMailer | null;
    }
  ) {}

  async start() {
    await this.reload();
    this.timer = setInterval(() => {
      this.reload().catch((err) =>
        this.deps.logger.error('Reloading instance settings failed', err as Error)
      );
    }, RELOAD_MS);
    this.timer.unref();
  }

  stop() {
    clearInterval(this.timer);
  }

  /** Called after a reload that changed something (e.g. to rebuild sign-in providers). */
  onChange(listener: () => void) {
    this.listeners.push(listener);
  }

  /** The settings version: changes whenever a reload saw different settings. */
  get revision() {
    return this.version;
  }

  async reload() {
    const rows = await this.deps.systemDb.instanceConfig.findMany({
      where: { key: { in: INSTANCE_SETTING_KEYS.map(rowKey) } },
    });
    const next: Partial<Record<InstanceSettingKey, Json>> = {};
    for (const row of rows)
      next[row.key.slice('settings.'.length) as InstanceSettingKey] = row.value as Json;
    const snapshot = JSON.stringify(next);
    if (snapshot === this.snapshot) return;
    this.rows = next;
    this.snapshot = snapshot;
    this.version++;
    this.listeners.forEach((listener) => listener());
  }

  /** A stored value with its secrets opened. */
  private plain(key: InstanceSettingKey): Json | null {
    const stored = this.rows[key];
    if (!stored) return null;
    const value = structuredClone(stored);
    for (const path of SECRETS[key]) {
      const sealed = getPath(value, path);
      if (typeof sealed === 'string') {
        setPath(value, path, openSecret(sealed, this.deps.config.encryptionKey));
      }
    }
    return value;
  }

  private memo<K extends 'storage' | 'mailer'>(name: K, build: () => (typeof this.derived)[K]) {
    if (this.derived.version !== this.version) this.derived = { version: this.version };
    if (!(name in this.derived)) this.derived[name] = build();
    return this.derived[name]!;
  }

  // ─── Effective values ─────────────────────────────────────────────────────

  source(key: InstanceSettingKey): 'database' | 'environment' {
    return this.rows[key] ? 'database' : 'environment';
  }

  /** INST-11: the instance default storage, or null when there is none. */
  storage(): StorageTarget | null {
    return this.memo('storage', () => {
      const value = this.plain('storage') as StorageSettings | null;
      return value
        ? storageTargetFromSettings(value, this.deps.config)
        : instanceStorageTarget(this.deps.config);
    }) as StorageTarget | null;
  }

  storageAdapter(): string {
    return (this.rows.storage?.adapter as string | undefined) ?? this.deps.config.storage.adapter;
  }

  /** INST-12: outbound email, or null when none is configured in production. */
  mailer(): IMailer | null {
    return this.memo('mailer', () => {
      const value = this.plain('email') as EmailSettings | null;
      if (value) {
        return new SmtpMailer(
          {
            host: value.host,
            port: value.port,
            secure: value.security === 'tls',
            requireTLS: value.security === 'starttls',
            ignoreTLS: value.security === 'none',
            ...(value.username && { auth: { user: value.username, pass: value.password ?? '' } }),
          },
          value.from
        );
      }
      const { mail } = this.deps.config;
      return mail.smtpUrl ? new SmtpMailer(mail.smtpUrl, mail.from) : this.deps.fallbackMailer;
    }) as IMailer | null;
  }

  /** INST-13: which sign-in methods the instance allows. */
  auth(): EffectiveAuth {
    return this.resolveAuth(this.plain('auth'));
  }

  /** SES-01: the instance's session lifetime and idle timeout. */
  session(): { maxDays: number; idleMinutes: number | null } {
    return AuthSettingsSchema.parse(this.plain('auth') ?? {}).session;
  }

  /** The effective sign-in methods for an `auth` value (stored, or about to be). */
  private resolveAuth(stored: Json | null): EffectiveAuth {
    const value = AuthSettingsSchema.parse(stored ?? {});
    const { config } = this.deps;
    const allowed = (m: AuthMethod) => config.authMethods.allowed.includes(m);
    const env = config.github;
    const githubCreds =
      value.github.clientId && value.github.clientSecret
        ? { clientId: value.github.clientId, clientSecret: value.github.clientSecret }
        : (env ?? null);
    // A method needs the environment's permission (HARMONIQ_AUTH_METHODS) and the admin
    // panel's switch; the panel can turn methods off, never on beyond the environment.
    return {
      email: allowed('email') && value.email.enabled,
      github: allowed('github') && value.github.enabled ? githubCreds : null,
      instanceOidc: allowed('oidc') && value.oidc.enabled && !!config.oidc,
      oidc: allowed('sso-oidc') && value.oidc.enabled,
      saml: allowed('sso-saml') && value.saml.enabled,
      dev: config.devLogin,
    };
  }

  /**
   * Whether sessions from this provider may still be used: false once its method is
   * turned off (environment or admin panel), so they end at the next request.
   */
  sessionProviderEnabled(provider: string): boolean {
    const method = methodOfProvider(provider);
    if (!method) return true; // older or unknown ids: not ours to judge
    const auth = this.auth();
    switch (method) {
      case 'github':
        return !!auth.github;
      case 'email':
        return auth.email;
      case 'oidc':
        return auth.instanceOidc;
      case 'sso-oidc':
        return auth.oidc;
      case 'sso-saml':
        return auth.saml;
      case 'dev':
        return auth.dev;
    }
  }

  /**
   * INST-23: which instance admins could still sign in to the admin panel if `candidate`
   * (a plain `auth` value) were saved. Admin sessions can't come from a workspace's or
   * organization's SSO (`requireInstanceAdmin`), so only instance-wide methods count:
   * email and dev sign-in work for any account, GitHub and the instance OIDC only for
   * admins who have signed in with them before.
   */
  async adminSignInAfter(
    candidate: Json
  ): Promise<{ admins: Array<{ id: string; email: string; canSignIn: boolean }> }> {
    const next = this.resolveAuth(candidate);
    const anyAccount = (next.email && !!this.mailer()) || next.dev;
    const grants = await this.deps.systemDb.instanceAdmin.findMany({
      where: { revokedAt: null },
      include: { user: { include: { Identities: { select: { provider: true } } } } },
    });
    return {
      admins: grants.map(({ user }) => {
        const providers = new Set(user.Identities.map((i) => i.provider));
        const canSignIn =
          anyAccount ||
          (!!next.github && providers.has('github')) ||
          (next.instanceOidc && providers.has('oidc'));
        return { id: user.id, email: user.email, canSignIn };
      }),
    };
  }

  /**
   * Admin-panel switches the environment forbids (`HARMONIQ_AUTH_METHODS`), so the panel
   * shows them as locked and refuses to turn them on.
   */
  lockedAuthSettings(): Array<keyof typeof AUTH_SETTING_METHODS> {
    const { allowed } = this.deps.config.authMethods;
    return (Object.keys(AUTH_SETTING_METHODS) as Array<keyof typeof AUTH_SETTING_METHODS>).filter(
      (k) => !AUTH_SETTING_METHODS[k].some((m) => allowed.includes(m))
    );
  }

  /** Startup warnings: allowed methods that can't work for lack of credentials. */
  authWarnings(): string[] {
    const { config } = this.deps;
    const listed = config.authMethods.fromEnvironment ? config.authMethods.allowed : [];
    const auth = this.auth();
    const warnings: string[] = [];
    if (listed.includes('github') && !auth.github) {
      warnings.push(
        'HARMONIQ_AUTH_METHODS lists "github" but no GitHub OAuth app is configured (GITHUB_CLIENT_ID/SECRET or the admin panel)'
      );
    }
    if (listed.includes('oidc') && !config.oidc) {
      warnings.push(
        'HARMONIQ_AUTH_METHODS lists "oidc" but OIDC_ISSUER, OIDC_CLIENT_ID and OIDC_CLIENT_SECRET are not all set'
      );
    }
    if (listed.includes('email') && auth.email && !this.mailer()) {
      warnings.push(
        'HARMONIQ_AUTH_METHODS lists "email" but no outbound email is configured (SMTP_URL or the admin panel)'
      );
    }
    return warnings;
  }

  /** TLC-08: who may create organizations and standalone workspaces. */
  tenancy(): TenancySettings {
    return TenancySettingsSchema.parse(this.plain('tenancy') ?? {});
  }

  // ─── INST-34: database over environment ───────────────────────────────────

  /** PLN-02..05: enforcement, features and quotas per plan. */
  plans(): {
    enforced: boolean;
    features: Record<Plan, PlanFeature[]>;
    limits: Record<Plan, PlanLimits>;
  } {
    const env = this.deps.config.plans;
    const stored = PlansSettingsSchema.parse(this.plain('plans') ?? {});
    const plans: Plan[] = ['hobby', 'startup', 'enterprise'];
    return {
      enforced: stored.enforced ?? env.enforced,
      features: Object.fromEntries(
        plans.map((p) => [p, stored.features?.[p] ?? env.features[p]])
      ) as Record<Plan, PlanFeature[]>,
      limits: Object.fromEntries(
        plans.map((p) => [p, { ...env.limits[p], ...(stored.limits?.[p] ?? {}) }])
      ) as Record<Plan, PlanLimits>,
    };
  }

  /** RL-01..04, MT-12: requests per minute. */
  rateLimits() {
    const { config } = this.deps;
    const stored = RateLimitSettingsSchema.parse(this.plain('rateLimits') ?? {});
    const tier = (env: Record<Plan, number>, over?: Partial<Record<Plan, number>>) =>
      ({
        ...env,
        ...Object.fromEntries(Object.entries(over ?? {}).filter(([, v]) => v !== undefined)),
      }) as Record<Plan, number>;
    return {
      manifest: tier(config.manifestRateLimits, stored.manifest),
      write: stored.write ?? config.writeRateLimit,
      api: tier(config.apiRateLimits, stored.api),
      deploy: tier(config.deployRateLimits, stored.deploy),
      health: tier(config.healthRateLimits, stored.health),
    };
  }

  /** GC-03/06 and health-event retention. */
  gc() {
    const stored = GcSettingsSchema.parse(this.plain('gc') ?? {});
    return {
      keepVersions: stored.keepVersions ?? this.deps.config.gcKeepVersions,
      defaultRetentionDays: stored.defaultRetentionDays ?? 90,
      healthEventRetentionHours: stored.healthEventRetentionHours ?? 24,
      healthRollupRetentionDays: stored.healthRollupRetentionDays ?? 30,
    };
  }

  /** VAL-02/03. */
  bundles() {
    const stored = BundleSettingsSchema.parse(this.plain('bundles') ?? {});
    return { validate: stored.validate ?? this.deps.config.validateBundles };
  }

  /** INST-14. */
  branding(): BrandingSettings {
    return (this.plain('branding') as BrandingSettings | null) ?? { name: 'Harmoniq' };
  }

  // ─── Admin panel ──────────────────────────────────────────────────────────

  /** Settings for the admin panel: secrets masked, the environment's when not stored. */
  view() {
    const { config } = this.deps;
    const masked = (key: InstanceSettingKey, value: Json) => {
      const copy = structuredClone(value);
      for (const path of SECRETS[key]) {
        const secret = getPath(copy, path);
        if (typeof secret === 'string' && secret) setPath(copy, path, maskSecret(secret));
      }
      return copy;
    };
    const fromEnv: Record<InstanceSettingKey, Json> = {
      storage:
        config.storage.adapter === 's3'
          ? { ...config.storage, secretAccessKey: config.storage.secretAccessKey }
          : { adapter: config.storage.adapter },
      email: config.mail.smtpUrl ? { smtpUrl: 'SMTP_URL', from: config.mail.from } : {},
      auth: {
        email: { enabled: true },
        github: { enabled: !!config.github, clientId: config.github?.clientId },
        oidc: { enabled: true },
        saml: { enabled: true },
      },
      branding: { name: 'Harmoniq' },
      tenancy: { creation: 'anyone', allowedDomains: [] },
      // INST-34: what applies without a database value.
      plans: (() => {
        const { enforced, features, limits } = config.plans;
        return { enforced, features, limits } as unknown as Json;
      })(),
      rateLimits: {
        manifest: config.manifestRateLimits,
        write: config.writeRateLimit,
        api: config.apiRateLimits,
        deploy: config.deployRateLimits,
        health: config.healthRateLimits,
      },
      gc: {
        keepVersions: config.gcKeepVersions,
        defaultRetentionDays: 90,
        healthEventRetentionHours: 24,
        healthRollupRetentionDays: 30,
      },
      bundles: { validate: config.validateBundles },
    };
    const locked = this.lockedAuthSettings();
    const view = Object.fromEntries(
      INSTANCE_SETTING_KEYS.map((key) => [
        key,
        {
          source: this.source(key),
          value: masked(key, this.plain(key) ?? fromEnv[key]),
        },
      ])
    ) as Record<InstanceSettingKey, { source: 'database' | 'environment'; value: Json }>;
    // Switches the environment forbids show as off, whatever is stored.
    for (const k of locked) {
      view.auth.value[k] = { ...((view.auth.value[k] as Json | undefined) ?? {}), enabled: false };
    }
    return {
      ...view,
      auth: {
        ...view.auth,
        /** Switches locked off by HARMONIQ_AUTH_METHODS. */
        locked,
        allowedMethods: config.authMethods.allowed,
        methodsFromEnvironment: config.authMethods.fromEnvironment,
      },
    };
  }

  /**
   * Validates a new value; omitted secrets keep the stored ones (for storage, only with
   * the same adapter). Returns the value to store (sealed) and in plain form.
   */
  prepare(key: InstanceSettingKey, input: unknown) {
    const parsed = InstanceSettingSchemas[key].parse(input) as Json;
    if (key === 'auth') {
      const turnedOn = this.lockedAuthSettings().filter(
        (k) => (parsed[k] as { enabled?: boolean } | undefined)?.enabled
      );
      if (turnedOn.length) {
        throw new BadRequestError(
          `Sign-in methods not allowed by HARMONIQ_AUTH_METHODS can't be enabled: ${turnedOn.join(', ')}`
        );
      }
    }
    const previous = this.plain(key);
    const sameShape = key !== 'storage' || previous?.adapter === parsed.adapter;
    const plain = structuredClone(parsed);
    for (const path of SECRETS[key]) {
      if (getPath(plain, path) === undefined && sameShape && previous) {
        const kept = getPath(previous, path);
        if (kept !== undefined) setPath(plain, path, kept);
      }
    }
    const stored = structuredClone(plain);
    for (const path of SECRETS[key]) {
      const secret = getPath(stored, path);
      if (typeof secret === 'string') {
        setPath(stored, path, sealSecret(secret, this.deps.config.encryptionKey));
      }
    }
    // Field names that changed, for the audit event (INST-18: never values).
    const fields = [...new Set([...Object.keys(parsed), ...Object.keys(previous ?? {})])].filter(
      (f) => JSON.stringify(plain[f]) !== JSON.stringify(previous?.[f])
    );
    return { plain, stored, fields };
  }

  async save(
    key: InstanceSettingKey,
    stored: Json,
    actorId: string,
    source: 'save' | 'restore' | 'import' = 'save'
  ) {
    const { systemDb } = this.deps;
    await systemDb.$transaction([
      systemDb.instanceConfig.upsert({
        where: { key: rowKey(key) },
        create: { key: rowKey(key), value: stored as Prisma.InputJsonValue, updatedBy: actorId },
        update: { value: stored as Prisma.InputJsonValue, updatedBy: actorId },
      }),
    ]);
    await this.recordVersion(key, stored, actorId, source);
    await this.reload();
  }

  /** Back to the environment's defaults. */
  async reset(key: InstanceSettingKey, actorId = 'system') {
    const { count } = await this.deps.systemDb.instanceConfig.deleteMany({
      where: { key: rowKey(key) },
    });
    if (count) await this.recordVersion(key, {}, actorId, 'reset');
    await this.reload();
    return count > 0;
  }

  // ─── INST-35: versions, export and import ─────────────────────────────────

  private async recordVersion(
    key: InstanceSettingKey,
    stored: Json,
    actorId: string,
    source: 'save' | 'restore' | 'import' | 'reset'
  ) {
    const { systemDb } = this.deps;
    // Two saves at once: the unique (key, version) makes one retry with the next number.
    for (let attempt = 0; attempt < 3; attempt++) {
      const last = await systemDb.instanceConfigVersion.findFirst({
        where: { key },
        orderBy: { version: 'desc' },
        select: { version: true },
      });
      try {
        await systemDb.instanceConfigVersion.create({
          data: {
            key,
            version: (last?.version ?? 0) + 1,
            value: stored as Prisma.InputJsonValue,
            createdBy: actorId,
            source,
          },
        });
        return;
      } catch (err) {
        if (attempt === 2) throw err;
      }
    }
  }

  /** A stored (sealed) value in plain form. */
  openStored(key: InstanceSettingKey, stored: Json): Json {
    const value = structuredClone(stored);
    for (const path of SECRETS[key]) {
      const sealed = getPath(value, path);
      if (typeof sealed === 'string') {
        setPath(value, path, openSecret(sealed, this.deps.config.encryptionKey));
      }
    }
    return value;
  }

  /** Secrets out (for history views and exports). */
  withoutSecrets(key: InstanceSettingKey, value: Json): Json {
    const copy = structuredClone(value);
    for (const path of SECRETS[key]) {
      if (getPath(copy, path) !== undefined) setPath(copy, path, undefined);
    }
    return copy;
  }

  /** The versions of a setting, newest first, secrets left out, with what each changed. */
  async history(key: InstanceSettingKey) {
    const versions = await this.deps.systemDb.instanceConfigVersion.findMany({
      where: { key },
      orderBy: { version: 'desc' },
      take: 100,
    });
    return versions.map((v, i) => {
      const value = this.withoutSecrets(key, v.value as Json);
      const before = versions[i + 1] ? this.withoutSecrets(key, versions[i + 1].value as Json) : {};
      return {
        version: v.version,
        source: v.source,
        createdAt: v.createdAt.toISOString(),
        createdBy: v.createdBy,
        value,
        changed: changedPaths(before, value),
        // Secret fields changed too (never shown).
        secretsChanged: SECRETS[key].some(
          (path) =>
            JSON.stringify(getPath(v.value as Json, path)) !==
            JSON.stringify(
              versions[i + 1] ? getPath(versions[i + 1].value as Json, path) : undefined
            )
        ),
      };
    });
  }

  async savedVersion(key: InstanceSettingKey, version: number) {
    return this.deps.systemDb.instanceConfigVersion.findUnique({
      where: { key_version: { key, version } },
    });
  }

  /** Every setting stored in the database, secrets left out, as YAML. */
  exportYaml() {
    const settings = Object.fromEntries(
      INSTANCE_SETTING_KEYS.filter((k) => this.rows[k]).map((k) => [
        k,
        this.withoutSecrets(k, this.plain(k)!),
      ])
    );
    return YAML.stringify({
      harmoniq: 'instance-settings/v1',
      exportedAt: new Date().toISOString(),
      settings,
    });
  }

  /** Parses an export: the settings it holds, by key (unknown keys refused). */
  parseImport(text: string): Partial<Record<InstanceSettingKey, Json>> {
    let doc: { harmoniq?: string; settings?: Record<string, unknown> };
    try {
      doc = YAML.parse(text) ?? {};
    } catch (err) {
      throw new BadRequestError(`Not valid YAML: ${(err as Error).message}`);
    }
    if (doc.harmoniq !== 'instance-settings/v1' || typeof doc.settings !== 'object') {
      throw new BadRequestError('Not a Harmoniq settings export (harmoniq: instance-settings/v1)');
    }
    const unknown = Object.keys(doc.settings ?? {}).filter(
      (k) => !(INSTANCE_SETTING_KEYS as readonly string[]).includes(k)
    );
    if (unknown.length) throw new BadRequestError(`Unknown settings: ${unknown.join(', ')}`);
    return doc.settings as Partial<Record<InstanceSettingKey, Json>>;
  }
}

/** Dotted paths whose values differ between two objects (for a version's diff). */
export function changedPaths(before: unknown, after: unknown, prefix = ''): string[] {
  const isObject = (v: unknown) => !!v && typeof v === 'object' && !Array.isArray(v);
  if (isObject(before) && isObject(after)) {
    const keys = new Set([...Object.keys(before as Json), ...Object.keys(after as Json)]);
    return [...keys].flatMap((k) =>
      changedPaths((before as Json)[k], (after as Json)[k], prefix ? `${prefix}.${k}` : k)
    );
  }
  return JSON.stringify(before) === JSON.stringify(after) ? [] : [prefix || '(value)'];
}
