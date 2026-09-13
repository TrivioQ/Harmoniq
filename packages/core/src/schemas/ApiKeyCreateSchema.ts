import { z } from 'zod';

export const ApiKeyCreateSchema = z.object({
  name: z.string().min(1).max(255),
  expiresAt: z.string().datetime().optional(),
});

export type ApiKeyCreate = z.infer<typeof ApiKeyCreateSchema>;
