import { z } from 'zod';

export const ApprovalDecisionSchema = z.object({
  comment: z.string().optional(),
});

export const ApprovalBypassSchema = z.object({
  bypassJustification: z.string().min(20),
});
