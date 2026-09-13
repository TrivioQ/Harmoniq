import { z } from 'zod';

export const CreateOrganizationSchema = z.object({
  slug: z.string().min(3),
  name: z.string().min(1),
  plan: z.string().optional().default('hobby'),
});

export type CreateOrganizationDto = z.infer<typeof CreateOrganizationSchema>;
