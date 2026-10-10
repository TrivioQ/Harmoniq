// Copyright The Harmoniq Authors
// SPDX-License-Identifier: Apache-2.0

/**
 * Creates (or re-passwords) the RLS-bound app role before migrations run, using the
 * credentials in DATABASE_URL and the owner connection in SYSTEM_DATABASE_URL.
 *
 * Run before `prisma migrate deploy` on managed databases (RDS, Cloud SQL) where the
 * owner/master user can create roles. Without it, an early migration would create the
 * app role with a default password.
 *
 *   tsx scripts/bootstrap-db.ts && (cd ../../packages/db && npx prisma migrate deploy)
 */
import { PrismaClient } from '@prisma/client';

async function main() {
  const appUrl = process.env.DATABASE_URL;
  const ownerUrl = process.env.SYSTEM_DATABASE_URL;
  if (!appUrl || !ownerUrl) throw new Error('DATABASE_URL and SYSTEM_DATABASE_URL are required');

  const app = new URL(appUrl);
  const role = decodeURIComponent(app.username);
  const password = decodeURIComponent(app.password);
  if (!/^[a-z_][a-z0-9_]*$/i.test(role)) throw new Error(`Unsupported role name: ${role}`);
  if (!password) throw new Error('DATABASE_URL must include the app role password');
  if (role === decodeURIComponent(new URL(ownerUrl).username)) {
    throw new Error(
      'DATABASE_URL must use a different role than SYSTEM_DATABASE_URL (RLS needs a non-owner role)'
    );
  }

  // DDL can't take bind parameters: the identifier is validated above, the literal escaped.
  const literal = `'${password.replace(/'/g, "''")}'`;
  const db = new PrismaClient({ datasources: { db: { url: ownerUrl } } });
  try {
    const exists = await db.$queryRaw<Array<{ exists: boolean }>>`
      SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = ${role}) AS "exists"`;
    if (exists[0]?.exists) {
      await db.$executeRawUnsafe(`ALTER ROLE "${role}" WITH LOGIN PASSWORD ${literal}`);
      console.log(`Updated password of role ${role}`);
    } else {
      await db.$executeRawUnsafe(`CREATE ROLE "${role}" WITH LOGIN PASSWORD ${literal}`);
      console.log(`Created role ${role}`);
    }
  } finally {
    await db.$disconnect();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
