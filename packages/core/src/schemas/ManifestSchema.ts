import { z } from 'zod';

export const ModuleSchema = z.object({
  name: z.string(),
  /** Import-map specifier when it differs from `name`, e.g. `@acme/checkout`. */
  specifier: z.string().optional(),
  url: z.string().url(),
  integrity: z.string(),
  version: z.string(),
  dependencies: z.record(z.string()).optional(),
  exposes: z.record(z.string()).optional(),
  metadata: z.record(z.unknown()).optional(),
  /** Kill switch (M3.6): hosts must not load this module. */
  disabled: z.boolean().optional(),
  disabledReason: z.string().optional(),
  /** ORG-11: published by another workspace of the organization (read-only here). */
  shared: z.boolean().optional(),
  /** ORG-11: the workspace that owns a shared module. */
  ownerWorkspace: z.string().optional(),
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
