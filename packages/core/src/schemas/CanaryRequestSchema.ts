import { z } from 'zod';

/** CAN-01: a canary always shares traffic with a stable version. */
export const TrafficPercentSchema = z.number().int().min(1).max(99);

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

/** CAN-04: promote the canary to active, or abort it (back to inactive). */
export const CanaryActionRequestSchema = z.object({
  environment: z.string().min(1),
  /** Why the canary was aborted or promoted; stored in the audit event. */
  reason: z.string().max(500).optional(),
});

export type CanaryActionRequest = z.infer<typeof CanaryActionRequestSchema>;
