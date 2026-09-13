import { z } from 'zod';

export const RollbackRequestSchema = z.object({
  versionId: z.string().cuid(),
});

export type RollbackRequest = z.infer<typeof RollbackRequestSchema>;
