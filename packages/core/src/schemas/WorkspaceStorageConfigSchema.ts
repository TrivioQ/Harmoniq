import { z } from 'zod';

// `local` is not tenant-isolatable, so it can't be a workspace bucket (BYOB-02).
export const WorkspaceStorageProviderSchema = z.enum(['S3', 'GCS', 'AZURE']);
export type WorkspaceStorageProvider = z.infer<typeof WorkspaceStorageProviderSchema>;

/**
 * BYOB-03: the credentials each provider takes.
 * - S3: `accessKeyId` + `secretAccessKey`, or `roleArn` (+ `externalId`) assumed with the
 *   registry's own AWS identity.
 * - GCS: `serviceAccountJson` (the key file), or `projectId` + `clientEmail` + `privateKey`.
 * - Azure: `connectionString` (with `AccountName` and `AccountKey` for upload URLs).
 */
export function storageCredentialsProblem(
  provider: WorkspaceStorageProvider,
  c: Record<string, string>
): string | null {
  if (provider === 'S3') {
    if (c.roleArn) {
      return /^arn:aws[\w-]*:iam::\d{12}:role\/[\w+=,.@/-]+$/.test(c.roleArn)
        ? null
        : 'roleArn must look like arn:aws:iam::123456789012:role/name';
    }
    return c.accessKeyId && c.secretAccessKey
      ? null
      : 'S3 needs accessKeyId and secretAccessKey, or roleArn';
  }
  if (provider === 'GCS') {
    if (c.serviceAccountJson) {
      try {
        const key = JSON.parse(c.serviceAccountJson) as Record<string, unknown>;
        return key.client_email && key.private_key
          ? null
          : 'The service account JSON has no client_email or private_key';
      } catch {
        return 'serviceAccountJson is not valid JSON';
      }
    }
    return c.projectId && c.clientEmail && c.privateKey
      ? null
      : 'GCS needs serviceAccountJson, or projectId, clientEmail and privateKey';
  }
  return /AccountName=/.test(c.connectionString ?? '') ||
    /BlobEndpoint=/.test(c.connectionString ?? '')
    ? null
    : 'Azure needs a connectionString';
}

export const WorkspaceStorageConfigSchema = z
  .object({
    provider: WorkspaceStorageProviderSchema,
    /** Bucket (S3, GCS) or container (Azure). */
    bucket: z.string().min(1).max(255),
    region: z.string().min(1).max(64),
    /** S3-compatible endpoint (MinIO, Cloudflare R2 …); S3 only. */
    endpoint: z.string().url().optional(),
    /**
     * Plaintext credentials, encrypted before storage and never returned. Optional on
     * update: omit to keep the stored credentials (e.g. when only changing the bucket).
     */
    credentials: z.record(z.string().min(1)).optional(),
    cdnPrefix: z.string().url().optional(),
    pathPrefix: z
      .string()
      .max(200)
      .regex(/^[\w./-]*$/, 'Letters, digits, ".", "_", "-" and "/"')
      .optional(),
  })
  .superRefine((value, ctx) => {
    if (value.endpoint && value.provider !== 'S3') {
      ctx.addIssue({ code: 'custom', path: ['endpoint'], message: 'Only S3 takes an endpoint' });
    }
    const problem =
      value.credentials && storageCredentialsProblem(value.provider, value.credentials);
    if (problem) ctx.addIssue({ code: 'custom', path: ['credentials'], message: problem });
  });

export type WorkspaceStorageConfigDto = z.infer<typeof WorkspaceStorageConfigSchema>;

/** What the API returns: secrets masked, e.g. `{ secretAccessKey: "••••a1b2" }`. */
export const WorkspaceStorageConfigResponseSchema = z.object({
  provider: WorkspaceStorageProviderSchema,
  bucket: z.string(),
  region: z.string(),
  endpoint: z.string().optional(),
  cdnPrefix: z.string().optional(),
  pathPrefix: z.string().optional(),
  maskedCredentials: z.record(z.string()),
  lastVerifiedAt: z.string().datetime().nullable(),
  updatedAt: z.string().datetime(),
});

export type WorkspaceStorageConfigResponse = z.infer<typeof WorkspaceStorageConfigResponseSchema>;
