import { z } from 'zod';

/** Lowercase, digits and inner hyphens. Slugs appear in URLs and cache-key patterns. */
export const SlugSchema = z
  .string()
  .regex(/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/, 'Use lowercase letters, digits and hyphens');

export const CreateWorkspaceSchema = z.object({
  name: z.string().min(1).max(120),
  slug: SlugSchema,
});

// ─── Organizations (ORG-01..15) ─────────────────────────────────────────────

export const OrgRoleSchema = z.enum(['org_admin', 'org_member']);
export type OrgRole = z.infer<typeof OrgRoleSchema>;

export const CreateOrganizationSchema = z.object({
  name: z.string().min(1).max(120),
  slug: SlugSchema,
});

export const UpdateOrganizationSchema = z.object({ name: z.string().min(1).max(120) });

export const AddOrgMemberSchema = z.object({
  email: z.string().email().max(320),
  role: OrgRoleSchema.default('org_member'),
});

export const UpdateOrgMemberSchema = z.object({ role: OrgRoleSchema });

/** ORG-13: org keys reach all of the org's workspaces, or only the listed ones / modules. */
export const CreateOrgApiKeySchema = z.object({
  name: z.string().min(1).max(120),
  scopes: z
    .array(z.enum(['manifest:read', 'deploy:write', 'admin']))
    .min(1)
    .default(['deploy:write']),
  workspaces: z.array(SlugSchema).max(100).default([]),
  moduleIds: z.array(z.string().min(1)).max(500).default([]),
  expiresAt: z.coerce.date().optional(),
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

/** RBAC-01: replace a module's owners (workspace member ids); `[]` makes it ownerless. */
export const SetModuleOwnersSchema = z.object({
  memberIds: z.array(z.string().min(1)).max(100),
});
