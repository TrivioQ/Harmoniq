import { z } from 'zod';

// INST-01..10: instance administration requests.

/** INST-01..04: the first-boot wizard; every step proves the one-time setup token. */
export const SetupTokenSchema = z.object({ setupToken: z.string().min(1) });

export const SetupCompleteSchema = SetupTokenSchema.extend({
  email: z.string().trim().toLowerCase().email(),
  name: z.string().trim().max(120).optional(),
});

/** INST-09: suspended workspaces stay readable; changes are refused. */
export const SuspendWorkspaceSchema = z.object({
  reason: z.string().trim().max(500).optional(),
});

/** INST-07: grant instance admin to an existing user. */
export const GrantInstanceAdminSchema = z.object({
  email: z.string().trim().toLowerCase().email(),
});
