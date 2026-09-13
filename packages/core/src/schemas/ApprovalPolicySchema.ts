import { z } from 'zod';

export const ApprovalPolicySchema = z.object({
  requiredApprovers: z.number().min(1).default(1),
  eligibleRoles: z.array(z.string()).min(1),
  requireChangeTicket: z.boolean().default(false),
  ticketUrlPattern: z.string().url().optional(),
  expiryHours: z.number().min(1).default(24),
});

export type ApprovalPolicyDto = z.infer<typeof ApprovalPolicySchema>;
