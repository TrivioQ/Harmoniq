// Copyright The Harmoniq Authors
// SPDX-License-Identifier: Apache-2.0

import { z } from 'zod';

// KEY-02. `admin` never grants owner-only operations.
export const ApiKeyScopeSchema = z.enum(['manifest:read', 'deploy:write', 'admin']);
export type ApiKeyScope = z.infer<typeof ApiKeyScopeSchema>;

export const ApiKeyCreateSchema = z.object({
  name: z.string().min(1).max(255),
  scopes: z.array(ApiKeyScopeSchema).min(1).default(['deploy:write']),
  /** Restrict the key to these modules (RBAC-04). Empty means all modules. */
  moduleIds: z.array(z.string().min(1)).default([]),
  expiresAt: z.string().datetime().optional(),
});

export type ApiKeyCreate = z.infer<typeof ApiKeyCreateSchema>;
