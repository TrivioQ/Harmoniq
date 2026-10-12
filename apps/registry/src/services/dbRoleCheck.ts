// Copyright The Harmoniq Authors
// SPDX-License-Identifier: Apache-2.0

import { PrismaClient } from '@prisma/client';

/** The password an early migration gives `harmoniq_app` when the role doesn't exist yet. */
export const PLACEHOLDER_PASSWORD = 'password';

/**
 * MT-11: whether the runtime database role (from `DATABASE_URL`) can sign in with the
 * placeholder password. That happens when migrations ran before the role was created
 * (`scripts/bootstrap-db.ts`): anyone who can reach the database could then connect as
 * the app role. Connection failures count as "no".
 */
export async function appRoleAcceptsPlaceholder(databaseUrl: string): Promise<boolean> {
  let url: URL;
  try {
    url = new URL(databaseUrl);
  } catch {
    return false;
  }
  if (decodeURIComponent(url.password) === PLACEHOLDER_PASSWORD) return true;
  url.password = PLACEHOLDER_PASSWORD;
  url.searchParams.set('connect_timeout', '5');
  const probe = new PrismaClient({ datasources: { db: { url: url.toString() } } });
  try {
    await probe.$queryRaw`SELECT 1`;
    return true;
  } catch {
    return false;
  } finally {
    await probe.$disconnect().catch(() => undefined);
  }
}
