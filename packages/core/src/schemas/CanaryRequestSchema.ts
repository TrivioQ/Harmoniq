import { z } from 'zod';

/** CAN-01: a canary always shares traffic with a stable version. */
export const TrafficPercentSchema = z.number().int().min(1).max(99);

/** STG-01: one traffic band of a staged rollout. */
export const RolloutBandSchema = z.object({
  percent: z.number().int().min(1).max(100),
  /** How long the band runs before the gate is checked. Ignored for the final 100% band. */
  holdMinutes: z
    .number()
    .int()
    .min(0)
    .max(7 * 24 * 60),
});

/**
 * STG-02/04: checked over each band before moving on. A failed check aborts the canary;
 * fewer than `minSamples` canary loads means waiting (or advancing by hand).
 */
export const RolloutGateSchema = z.object({
  /** Failed share of canary loads. */
  maxErrorRate: z.number().min(0).max(1).optional(),
  /** Canary error rate minus stable error rate. */
  maxErrorRateDelta: z.number().min(0).max(1).optional(),
  /** p95 load time of the canary, in milliseconds. */
  maxP95Ms: z.number().int().positive().optional(),
  minSamples: z.number().int().min(1).max(100_000).default(20),
});

/** Bands in increasing order; reaching the final 100% band promotes the canary (STG-03). */
export const RolloutScheduleSchema = z
  .object({
    bands: z.array(RolloutBandSchema).min(2).max(20),
    gate: RolloutGateSchema.default({}),
  })
  .refine((s) => s.bands.every((b, i) => i === 0 || b.percent > s.bands[i - 1].percent), {
    message: 'Band percentages must increase',
  })
  .refine((s) => s.bands[s.bands.length - 1].percent === 100, {
    message: 'The last band must be 100 (promote)',
  });

export type RolloutSchedule = z.infer<typeof RolloutScheduleSchema>;

/**
 * CAN-05: changes the running canary's traffic, or (with `versionId`) makes an earlier
 * version of this module in the environment the canary.
 */
export const SetCanaryRequestSchema = z.object({
  environment: z.string().min(1),
  trafficPercent: TrafficPercentSchema,
  versionId: z.string().min(1).optional(),
});

export type SetCanaryRequest = z.infer<typeof SetCanaryRequestSchema>;

/**
 * CAN-04: promote the canary to active, or abort it (back to inactive). STG-05: `advance`
 * moves a staged rollout to its next band now, without waiting for the gate.
 */
export const CanaryActionRequestSchema = z.object({
  environment: z.string().min(1),
  /** Why the canary was aborted or promoted; stored in the audit event. */
  reason: z.string().max(500).optional(),
});

export type CanaryActionRequest = z.infer<typeof CanaryActionRequestSchema>;
