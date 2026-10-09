import { z } from 'zod';

/** HLT-01: one module load outcome, as reported by the SDK. */
export const HealthEventSchema = z.object({
  /** Module name as it appears in the manifest. */
  module: z.string().min(1).max(100),
  /** The version that was loaded; the registry derives the variant from it. */
  version: z.string().min(1).max(128),
  success: z.boolean(),
  loadMs: z.number().int().min(0).max(600_000).optional(),
  /** Error message for failed loads (truncated by the SDK). */
  error: z.string().max(500).optional(),
});

export type HealthEvent = z.infer<typeof HealthEventSchema>;

/** Body of `POST /api/health/:workspace/:hostApp/:env`. */
export const HealthReportSchema = z.object({
  events: z.array(HealthEventSchema).min(1).max(50),
  /** SDK version, for debugging. */
  client: z.string().max(32).optional(),
});

export type HealthReport = z.infer<typeof HealthReportSchema>;

/** HLT-03: health of one module (and variant) over a window. */
export interface HealthStats {
  sampleCount: number;
  errorCount: number;
  /** 0–1, or null without samples. */
  loadSuccessRate: number | null;
  p50LoadMs: number | null;
  p95LoadMs: number | null;
}
