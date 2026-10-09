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

/** npm-style specifier for import maps, e.g. `@acme/checkout` (IMP-03). */
export const SpecifierSchema = z
  .string()
  .max(214)
  .regex(
    /^(@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/,
    'Use an npm-style name such as @acme/checkout'
  );

export const UpdateModuleSchema = z.object({
  name: z.string().min(1).max(120).optional(),
  description: z.string().max(500).nullable().optional(),
  /** null resets to the module slug. */
  specifier: SpecifierSchema.nullable().optional(),
});

export const UpdateWorkspaceSchema = z.object({
  name: z.string().min(1).max(120).optional(),
  retentionDays: z.number().int().min(1).max(3650).optional(),
  allowEphemeralEnvironments: z.boolean().optional(),
});

export const UpdateHostAppSchema = z.object({
  name: z.string().min(1).max(120).optional(),
  description: z.string().max(500).nullable().optional(),
  /** e.g. `https://staging.acme.com/?harmoniq-env={environment}`; null removes it. */
  previewUrlTemplate: z
    .string()
    .url()
    .refine((v) => v.includes('{environment}'), 'Must contain {environment}')
    .nullable()
    .optional(),
  /** M3.7: package → semver range the host shares with every module; null removes. */
  sharedDependencies: z.record(z.string().min(1).max(200)).nullable().optional(),
  /** M3.7: reject deploys that drop an exposed module the active version had. */
  strictExposes: z.boolean().optional(),
});
