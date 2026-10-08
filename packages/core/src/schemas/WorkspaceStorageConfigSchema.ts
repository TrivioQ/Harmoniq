import { z } from 'zod';

// `local` is not tenant-isolatable, so it can't be a workspace bucket (BYOB-02).
export const WorkspaceStorageProviderSchema = z.enum(['S3', 'GCS']);

export const WorkspaceStorageConfigSchema = z.object({
  provider: WorkspaceStorageProviderSchema,
  bucket: z.string().min(1),
  region: z.string().min(1),
  /**
   * Plaintext credentials, encrypted before storage and never returned. Optional on
   * update: omit to keep the stored credentials (e.g. when only changing the bucket).
   */
  credentials: z.record(z.string().min(1)).optional(),
  cdnPrefix: z.string().url().optional(),
  pathPrefix: z.string().optional(),
});

export type WorkspaceStorageConfigDto = z.infer<typeof WorkspaceStorageConfigSchema>;

/** What the API returns: secrets masked, e.g. `{ secretAccessKey: "••••a1b2" }`. */
export const WorkspaceStorageConfigResponseSchema = WorkspaceStorageConfigSchema.omit({
  credentials: true,
}).extend({
  maskedCredentials: z.record(z.string()),
  lastVerifiedAt: z.string().datetime().nullable(),
  updatedAt: z.string().datetime(),
});

export type WorkspaceStorageConfigResponse = z.infer<typeof WorkspaceStorageConfigResponseSchema>;
