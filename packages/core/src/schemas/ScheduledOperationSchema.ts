import { z } from 'zod';
import { DeployRequestSchema } from './DeployRequestSchema';
import { PromoteRequestSchema, RollbackRequestSchema } from './RollbackRequestSchema';
import {
  CanaryActionRequestSchema,
  KillSwitchRequestSchema,
  SetCanaryRequestSchema,
} from './CanaryRequestSchema';

// Not `module`: compiled to CommonJS, that name would shadow Node's own `module`.
const moduleRef = z.string().min(1);

/**
 * M3.6: what to run later. Each operation carries the body of the API call it stands for,
 * validated now with the same schema the route uses.
 */
export const ScheduledOperationSpecSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('deploy'), module: moduleRef, request: DeployRequestSchema }),
  z.object({ type: z.literal('promote'), module: moduleRef, request: PromoteRequestSchema }),
  z.object({ type: z.literal('rollback'), module: moduleRef, request: RollbackRequestSchema }),
  z.object({
    type: z.literal('canary_traffic'),
    module: moduleRef,
    request: SetCanaryRequestSchema,
  }),
  z.object({
    type: z.literal('canary_promote'),
    module: moduleRef,
    request: CanaryActionRequestSchema,
  }),
  z.object({
    type: z.literal('canary_abort'),
    module: moduleRef,
    request: CanaryActionRequestSchema,
  }),
  z.object({ type: z.literal('kill_switch'), module: moduleRef, request: KillSwitchRequestSchema }),
]);
export type ScheduledOperationSpec = z.infer<typeof ScheduledOperationSpecSchema>;

export const CreateScheduledOperationSchema = z.object({
  runAt: z.string().datetime({ offset: true }),
  description: z.string().max(500).optional(),
  operation: ScheduledOperationSpecSchema,
});
export type CreateScheduledOperation = z.infer<typeof CreateScheduledOperationSchema>;
