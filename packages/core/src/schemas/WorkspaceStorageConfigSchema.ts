import { z } from 'zod';

export const WorkspaceStorageConfigSchema = z.object({
  provider: z.string().min(1),
  bucket: z.string().min(1),
  region: z.string().min(1),
  credentials: z.record(z.string()),
  cdnPrefix: z.string().url().optional(),
  pathPrefix: z.string().optional(),
});

export type WorkspaceStorageConfigDto = z.infer<typeof WorkspaceStorageConfigSchema>;
