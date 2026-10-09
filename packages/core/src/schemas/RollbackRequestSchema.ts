import { z } from 'zod';

// VER-04. Exactly one target: a version record, a version string, or "the previous one".
export const RollbackRequestSchema = z
  .object({
    environment: z.string().min(1),
    versionId: z.string().min(1).optional(),
    version: z.string().min(1).optional(),
    previous: z.literal(true).optional(),
  })
  .refine((r) => [r.versionId, r.version, r.previous].filter(Boolean).length === 1, {
    message: 'Specify exactly one of versionId, version or previous',
  });

export type RollbackRequest = z.infer<typeof RollbackRequestSchema>;

// PRO-01. Copies the exact artifact (URL + integrity) that runs in `fromEnvironment`.
export const PromoteRequestSchema = z.object({
  fromEnvironment: z.string().min(1),
  toEnvironment: z.string().min(1),
  /** Defaults to the active version in `fromEnvironment`. */
  versionId: z.string().min(1).optional(),
});

export type PromoteRequest = z.infer<typeof PromoteRequestSchema>;

// ENV-FRZ-01.
export const FreezeRequestSchema = z.object({
  reason: z.string().min(3).max(500),
  until: z.string().datetime().optional(),
});

export type FreezeRequest = z.infer<typeof FreezeRequestSchema>;
