// Copyright The Harmoniq Authors
// SPDX-License-Identifier: Apache-2.0

import { Prisma, PrismaClient } from '@prisma/client';

export * from '@prisma/client';

export type TenantTx = Prisma.TransactionClient;

export interface DbClients {
  /** Runtime tenant role (harmoniq_app). Subject to RLS: only usable via `withTenant`. */
  db: PrismaClient;
  /**
   * Schema owner (harmoniq). Bypasses RLS. Only for resolving the tenant before any
   * tenant-scoped work (workspace by slug, API key by id), background jobs, and
   * instance-admin operations.
   */
  systemDb: PrismaClient;
}

export function createDbClients(env: NodeJS.ProcessEnv = process.env): DbClients {
  const systemUrl = env.SYSTEM_DATABASE_URL;
  if (!systemUrl) {
    // Falling back to the tenant role would make every system query silently return nothing.
    throw new Error('SYSTEM_DATABASE_URL is required (schema owner connection, see .env.example)');
  }
  return {
    db: new PrismaClient(),
    systemDb: new PrismaClient({ datasources: { db: { url: systemUrl } } }),
  };
}

/**
 * Runs `fn` in a transaction scoped to one workspace. Every query inside sees only that
 * workspace's rows (enforced by Postgres RLS, not by application filters).
 */
export function withTenant<T>(
  client: PrismaClient,
  workspaceId: string,
  fn: (tx: TenantTx) => Promise<T>,
  options?: { timeout?: number; maxWait?: number }
): Promise<T> {
  return client.$transaction(async (tx) => {
    // is_local = true: the setting ends with this transaction, so pooled connections
    // never leak one tenant's context into another request.
    await tx.$executeRaw`SELECT set_config('app.current_workspace_id', ${workspaceId}, true)`;
    return fn(tx);
  }, options);
}
