import { z } from 'zod';

// WHK-02 + WHK-11.
export const WebhookEventNameSchema = z.enum([
  'manifest.updated',
  'manifest.publish_failed',
  'deploy.success',
  'deploy.failed',
  'rollback.executed',
  'module.promoted',
  'canary.started',
  'canary.updated',
  'canary.promoted',
  'canary.rolled_back',
  'canary.auto_rolled_back',
  'module.auto_rolled_back',
  'alert.triggered',
  'alert.resolved',
  'env.frozen',
  'env.unfrozen',
]);
export type WebhookEventName = z.infer<typeof WebhookEventNameSchema>;

export const WebhookEventSchema = z.object({
  id: z.string().uuid(),
  event: WebhookEventNameSchema,
  payload: z.record(z.unknown()),
  timestamp: z.string().datetime(),
  workspaceId: z.string().cuid(),
});

export type WebhookEvent = z.infer<typeof WebhookEventSchema>;
