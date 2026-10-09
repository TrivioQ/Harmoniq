import { z } from 'zod';
import { RolloutScheduleSchema, TrafficPercentSchema } from './CanaryRequestSchema';

export const DeployRequestSchema = z.object({
  /** Target environment slug, e.g. `staging`. */
  environment: z.string().min(1),
  url: z.string().url(),
  version: z.string().min(1).max(128),
  /** SRI hash, e.g. `sha384-…`. */
  integrity: z.string().regex(/^sha(256|384|512)-[A-Za-z0-9+/=]+$/, 'Expected an SRI hash'),
  commitSha: z.string().max(64).optional(),
  dependencies: z.record(z.string()).optional(),
  exposes: z.record(z.string()).optional(),
  metadata: z.record(z.unknown()).optional(),
  /** Bucket object key when the bundle was uploaded via `upload-url`. */
  storagePath: z.string().max(1024).optional(),
  dryRun: z.boolean().optional().default(false),
  /**
   * Create `environment` as a preview environment if it doesn't exist (workspace must
   * allow it); it is deleted `ttlHours` after the last deploy.
   */
  ephemeral: z.object({ ttlHours: z.number().int().min(1).max(720) }).optional(),
  /**
   * Deploy as a canary next to the active version instead of replacing it (CAN-01), at a
   * fixed `trafficPercent` or as a staged `rollout` (STG-01). Replaces a running canary of
   * the same module.
   */
  canary: z
    .object({
      trafficPercent: TrafficPercentSchema.optional(),
      rollout: RolloutScheduleSchema.optional(),
    })
    .refine((c) => !!c.trafficPercent !== !!c.rollout, {
      message: 'Give either trafficPercent or rollout',
    })
    .optional(),
});

export type DeployRequest = z.infer<typeof DeployRequestSchema>;
