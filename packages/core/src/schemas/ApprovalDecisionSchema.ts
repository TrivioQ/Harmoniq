// Copyright The Harmoniq Authors
// SPDX-License-Identifier: Apache-2.0

import { z } from 'zod';

/** APR-06: an approver's comment on approve or reject. */
export const ApprovalDecisionSchema = z.object({
  comment: z.string().max(1000).optional(),
});

/** APR-10: an owner's emergency bypass needs a written justification. */
export const ApprovalBypassSchema = z.object({
  bypassJustification: z.string().trim().min(20).max(2000),
});
