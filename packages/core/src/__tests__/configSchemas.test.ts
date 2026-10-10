import { describe, it, expect } from 'vitest';
import type { ZodTypeAny } from 'zod';
import { GitOpsConfigSchema } from '../schemas/GitOpsConfigSchema';
import {
  WorkspaceStorageConfigSchema,
  storageCredentialsProblem,
} from '../schemas/WorkspaceStorageConfigSchema';
import {
  AuthSettingsSchema,
  BrandingSettingsSchema,
  EmailSettingsSchema,
  InstanceSettingSchemas,
  StorageSettingsSchema,
} from '../schemas/InstanceSettingsSchemas';
import { OidcConfigSchema } from '../schemas/SsoSchema';
import { EmailLoginVerifySchema } from '../schemas/AuthSchemas';
import { SlugSchema, SpecifierSchema, UpdateHostAppSchema } from '../schemas/ResourceSchemas';

const problem = (schema: ZodTypeAny, value: unknown) => {
  const result = schema.safeParse(value);
  return result.success ? null : result.error.issues[0].message;
};

describe('harmoniq.yaml (GitOps)', () => {
  it('accepts a full workspace declaration', () => {
    const config = GitOpsConfigSchema.parse({
      version: 1,
      workspace: 'acme',
      hostApps: [
        {
          slug: 'portal',
          default: true,
          previewUrlTemplate: 'https://{environment}.preview.acme.dev',
          environments: [
            { slug: 'production', approvalPolicy: { eligibleRoles: ['owner'] } },
            { slug: 'staging', freeze: { reason: 'release', until: '2026-12-01T00:00:00Z' } },
          ],
          modules: [{ slug: 'checkout', owners: ['dev@acme.dev'] }],
        },
      ],
      webhooks: [{ url: 'https://hooks.acme.dev/harmoniq', events: ['*'] }],
      alertRules: [
        {
          name: 'canary errors',
          condition: 'canary_error_rate',
          threshold: 0.1,
          action: 'auto_rollback',
          module: 'portal/checkout',
          environment: 'production',
        },
      ],
    });
    expect(config.hostApps?.[0].environments?.[1].freeze?.until).toBeInstanceOf(Date);
  });

  it('rejects duplicates, two defaults and unknown keys', () => {
    expect(
      problem(GitOpsConfigSchema, {
        version: 1,
        hostApps: [
          {
            slug: 'portal',
            environments: [{ slug: 'prod' }, { slug: 'prod' }],
            modules: [{ slug: 'a' }, { slug: 'a' }],
          },
        ],
      })
    ).toBe('Duplicate environment prod');
    expect(
      problem(GitOpsConfigSchema, {
        version: 1,
        hostApps: [
          { slug: 'a', default: true },
          { slug: 'b', default: true },
        ],
      })
    ).toBe('Only one default host app');
    expect(
      problem(GitOpsConfigSchema, {
        version: 1,
        webhooks: [
          { url: 'https://x.dev', events: ['*'] },
          { url: 'https://x.dev', events: ['*'] },
        ],
      })
    ).toBe('Duplicate webhook https://x.dev');
    expect(problem(GitOpsConfigSchema, { version: 1, hostapps: [] })).toMatch(/Unrecognized/);
  });

  it('applies the alert rule checks', () => {
    const alert = { name: 'x', threshold: 1, action: 'webhook' };
    expect(
      problem(GitOpsConfigSchema, {
        version: 1,
        alertRules: [{ ...alert, condition: 'load_p95ms' }],
      })
    ).toBe('This condition needs a module and an environment');
    expect(
      problem(GitOpsConfigSchema, {
        version: 1,
        alertRules: [{ ...alert, condition: 'webhook_failure_rate', action: 'auto_rollback' }],
      })
    ).toBe('auto_rollback needs a module condition');
  });
});

describe('workspace storage (BYOB)', () => {
  it.each([
    ['S3', { accessKeyId: 'a', secretAccessKey: 'b' }, null],
    ['S3', { roleArn: 'arn:aws:iam::123456789012:role/harmoniq' }, null],
    ['S3', { roleArn: 'harmoniq' }, /roleArn must look like/],
    ['S3', { accessKeyId: 'a' }, /S3 needs/],
    ['GCS', { serviceAccountJson: '{"client_email":"a","private_key":"b"}' }, null],
    ['GCS', { serviceAccountJson: '{"client_email":"a"}' }, /no client_email or private_key/],
    ['GCS', { serviceAccountJson: 'not json' }, /not valid JSON/],
    ['GCS', { projectId: 'p', clientEmail: 'e', privateKey: 'k' }, null],
    ['GCS', { projectId: 'p' }, /GCS needs/],
    ['AZURE', { connectionString: 'AccountName=acme;AccountKey=x' }, null],
    ['AZURE', { connectionString: 'BlobEndpoint=https://x' }, null],
    ['AZURE', {}, /Azure needs/],
  ] as const)('%s %j', (provider, credentials, expected) => {
    const result = storageCredentialsProblem(provider, credentials as Record<string, string>);
    if (expected === null) expect(result).toBeNull();
    else expect(result).toMatch(expected);
  });

  it('takes an endpoint only for S3 and checks credentials', () => {
    const base = { bucket: 'b', region: 'eu-west-1' };
    expect(
      problem(WorkspaceStorageConfigSchema, {
        ...base,
        provider: 'GCS',
        endpoint: 'https://minio.local',
      })
    ).toBe('Only S3 takes an endpoint');
    expect(
      problem(WorkspaceStorageConfigSchema, { ...base, provider: 'S3', credentials: {} })
    ).toMatch(/S3 needs/);
    // Credentials are optional on update (the stored ones are kept).
    expect(problem(WorkspaceStorageConfigSchema, { ...base, provider: 'AZURE' })).toBeNull();
  });
});

describe('instance settings', () => {
  it('validates each setting', () => {
    expect(Object.keys(InstanceSettingSchemas)).toEqual(['storage', 'email', 'auth', 'branding']);
    expect(
      problem(StorageSettingsSchema, {
        adapter: 's3',
        bucket: 'manifests',
        region: 'eu-west-1',
        publicUrl: 'ftp://cdn.example.com',
      })
    ).toBe('An http(s) URL');
    expect(problem(StorageSettingsSchema, { adapter: 'azure', container: 'manifests' })).toBeNull();
    expect(EmailSettingsSchema.parse({ host: 'smtp', port: 587, from: 'a@b.c' }).security).toBe(
      'starttls'
    );
    expect(AuthSettingsSchema.parse({})).toMatchObject({
      email: { enabled: true },
      saml: { enabled: true },
    });
    expect(problem(BrandingSettingsSchema, { name: 'Acme', accentColor: 'blue' })).toBe(
      'A colour like #4f46e5'
    );
  });
});

describe('sign-in and resources', () => {
  it('normalises trusted domains and defaults OIDC settings', () => {
    const oidc = OidcConfigSchema.parse({
      issuer: 'https://login.acme.dev',
      clientId: 'harmoniq',
      trustedDomains: [' Acme.DEV '],
    });
    expect(oidc).toMatchObject({ trustedDomains: ['acme.dev'], defaultRole: 'viewer' });
    expect(
      problem(OidcConfigSchema, { issuer: 'https://x.dev', clientId: 'c', trustedDomains: ['x'] })
    ).toBe('A domain like acme.com');
  });

  it('verifies an email login by link token or by code', () => {
    const nonce = 'n'.repeat(16);
    expect(problem(EmailLoginVerifySchema, { token: 't'.repeat(16), nonce })).toBeNull();
    expect(problem(EmailLoginVerifySchema, { email: 'a@b.co', code: '123456' })).toBeNull();
    expect(problem(EmailLoginVerifySchema, { email: 'a@b.co', code: '12345' })).not.toBeNull();
  });

  it('checks slugs, specifiers and preview URL templates', () => {
    expect(problem(SlugSchema, 'acme-corp')).toBeNull();
    expect(problem(SlugSchema, '-acme')).toMatch(/lowercase/);
    expect(problem(SpecifierSchema, '@acme/checkout')).toBeNull();
    expect(problem(UpdateHostAppSchema, { previewUrlTemplate: 'https://preview.acme.dev' })).toBe(
      'Must contain {environment}'
    );
  });
});
