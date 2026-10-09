import { z } from 'zod';

/** APR-01/13: per-environment approval rules. */
export const ApprovalPolicySchema = z.object({
  requiredApprovers: z.number().int().min(1).max(10).default(1),
  eligibleRoles: z.array(z.enum(['developer', 'admin', 'owner'])).min(1),
  requireChangeTicket: z.boolean().default(false),
  /** Link built from the ticket id, e.g. `https://acme.atlassian.net/browse/{id}`. */
  ticketUrlPattern: z
    .string()
    .url()
    .refine((v) => v.includes('{id}'), 'Must contain {id}')
    .optional(),
  expiryHours: z.number().int().min(1).max(720).default(24),
});

export type ApprovalPolicyDto = z.infer<typeof ApprovalPolicySchema>;

/** APR-13: header carrying the change ticket id for a change that needs approval. */
export const CHANGE_TICKET_HEADER = 'x-harmoniq-change-ticket';
