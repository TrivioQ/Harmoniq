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
  /** DEP-03: promote despite dependency conflicts in the target (audited). */
  force: z.boolean().optional(),
});

export type PromoteRequest = z.infer<typeof PromoteRequestSchema>;

// ENV-FRZ-01.
// ENV-FRZ-04: `from` schedules the freeze window (e.g. a release weekend).
export const FreezeRequestSchema = z
  .object({
    reason: z.string().min(3).max(500),
    from: z.string().datetime({ offset: true }).optional(),
    until: z.string().datetime({ offset: true }).optional(),
  })
  .refine((f) => !f.from || !f.until || new Date(f.from) < new Date(f.until), {
    message: '`from` must be before `until`',
  });

/** ENV-FRZ-03: an owner opens a window in which changes pass the freeze (e.g. a hotfix from CI). */
export const FreezeOverrideRequestSchema = z.object({
  reason: z.string().min(10).max(500),
  minutes: z.number().int().min(5).max(240).default(60),
});

/** ENV-FRZ-03: header an owner sends to push a change through a freeze, with the reason. */
export const FREEZE_OVERRIDE_HEADER = 'x-harmoniq-freeze-override';

export type FreezeRequest = z.infer<typeof FreezeRequestSchema>;
