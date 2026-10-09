import { z } from 'zod';

/** Lowercase, digits and inner hyphens. Slugs appear in URLs and cache-key patterns. */
export const SlugSchema = z
  .string()
  .regex(/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/, 'Use lowercase letters, digits and hyphens');

export const CreateWorkspaceSchema = z.object({
  name: z.string().min(1).max(120),
  slug: SlugSchema,
});

export const CreateHostAppSchema = z.object({
  name: z.string().min(1).max(120),
  slug: SlugSchema,
  description: z.string().max(500).optional(),
  /** Environments created with the host app. */
  environments: z.array(SlugSchema).min(1).default(['staging', 'production']),
});

export const CreateEnvironmentSchema = z.object({
  name: z.string().min(1).max(120),
  slug: SlugSchema,
});

export const CreateModuleSchema = z.object({
  hostApp: SlugSchema,
  name: z.string().min(1).max(120),
  slug: SlugSchema,
  description: z.string().max(500).optional(),
});
