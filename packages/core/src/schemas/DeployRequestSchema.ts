import { z } from 'zod';

export const DeployRequestSchema = z.object({
  url: z.string().url(),
  version: z.string().min(1),
  integrity: z.string().min(1),
  commitSha: z.string().optional(),
  dependencies: z.record(z.string()).optional(),
  exposes: z.record(z.string()).optional(),
  metadata: z.record(z.unknown()).optional(),
  dryRun: z.boolean().optional().default(false),
});

export type DeployRequest = z.infer<typeof DeployRequestSchema>;
