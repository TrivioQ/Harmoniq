import { z } from 'zod';

export const CanaryConfigSchema = z.object({
  trafficPercentage: z.number().min(0).max(100),
  targetVersionId: z.string().cuid(),
  stableVersionId: z.string().cuid(),
  rules: z
    .array(
      z.object({
        headerName: z.string(),
        headerValue: z.string(),
      })
    )
    .optional(),
});

export type CanaryConfig = z.infer<typeof CanaryConfigSchema>;
