import { z } from 'zod';

export const ModuleSchema = z.object({
  name: z.string(),
  url: z.string().url(),
  integrity: z.string(),
  version: z.string(),
  dependencies: z.record(z.string()).optional(),
  exposes: z.record(z.string()).optional(),
  metadata: z.record(z.unknown()).optional(),
});

export const ManifestSchema = z.object({
  schemaVersion: z.literal(2),
  workspaceSlug: z.string(),
  hostApp: z.object({
    slug: z.string(),
    name: z.string(),
  }),
  environment: z.string(),
  variant: z.enum(['stable', 'canary']),
  cohortId: z.string(),
  generatedAt: z.string().datetime(),
  etag: z.string(),
  modules: z.array(ModuleSchema),
});

export type Manifest = z.infer<typeof ManifestSchema>;
export type Module = z.infer<typeof ModuleSchema>;
