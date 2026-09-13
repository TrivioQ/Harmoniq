import { z } from 'zod';

export const InstanceConfigSchema = z.object({
  key: z.string().min(1),
  value: z.record(z.unknown()),
});

export type InstanceConfigDto = z.infer<typeof InstanceConfigSchema>;
