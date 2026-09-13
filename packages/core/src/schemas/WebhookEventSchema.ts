import { z } from 'zod';

export const WebhookEventSchema = z.object({
  id: z.string().uuid(),
  event: z.enum(['module.deployed', 'module.rolled_back', 'manifest.published', 'health.failed']),
  payload: z.record(z.unknown()),
  timestamp: z.string().datetime(),
  workspaceId: z.string().cuid(),
});

export type WebhookEvent = z.infer<typeof WebhookEventSchema>;
