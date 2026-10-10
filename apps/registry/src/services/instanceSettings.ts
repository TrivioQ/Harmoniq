import type { Prisma, PrismaClient } from '@prisma/client';
import type { ILogger } from '@harmoniq/core/dist/ports/ILogger';
import type { IMailer } from '@harmoniq/core/dist/ports/IMailer';
import {
  AuthSettingsSchema,
  BrandingSettings,
  EmailSettings,
  InstanceSettingKey,
  InstanceSettingSchemas,
  INSTANCE_SETTING_KEYS,
  StorageSettings,
} from '@harmoniq/core/dist/schemas/InstanceSettingsSchemas';
import type { Config } from '../config';
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
  oidc: boolean;
  saml: boolean;
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
    const stored = this.plain('auth');
    const value = AuthSettingsSchema.parse(stored ?? {});
    const env = this.deps.config.github;
    const githubCreds =
      value.github.clientId && value.github.clientSecret
        ? { clientId: value.github.clientId, clientSecret: value.github.clientSecret }
        : (env ?? null);
    return {
      email: value.email.enabled,
      github: value.github.enabled ? githubCreds : null,
      oidc: value.oidc.enabled,
      saml: value.saml.enabled,
    };
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
    };
    return Object.fromEntries(
      INSTANCE_SETTING_KEYS.map((key) => [
        key,
        {
          source: this.source(key),
          value: masked(key, this.plain(key) ?? fromEnv[key]),
        },
      ])
    ) as Record<InstanceSettingKey, { source: 'database' | 'environment'; value: Json }>;
  }

  /**
   * Validates a new value; omitted secrets keep the stored ones (for storage, only with
   * the same adapter). Returns the value to store (sealed) and in plain form.
   */
  prepare(key: InstanceSettingKey, input: unknown) {
    const parsed = InstanceSettingSchemas[key].parse(input) as Json;
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

  async save(key: InstanceSettingKey, stored: Json, actorId: string) {
    await this.deps.systemDb.instanceConfig.upsert({
      where: { key: rowKey(key) },
      create: { key: rowKey(key), value: stored as Prisma.InputJsonValue, updatedBy: actorId },
      update: { value: stored as Prisma.InputJsonValue, updatedBy: actorId },
    });
    await this.reload();
  }

  /** Back to the environment's defaults. */
  async reset(key: InstanceSettingKey) {
    const { count } = await this.deps.systemDb.instanceConfig.deleteMany({
      where: { key: rowKey(key) },
    });
    await this.reload();
    return count > 0;
  }
}
