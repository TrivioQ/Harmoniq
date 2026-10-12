// Copyright The Harmoniq Authors
// SPDX-License-Identifier: Apache-2.0

/**
 * INST-24: instance recovery without the admin panel. Uses SYSTEM_DATABASE_URL (the schema
 * owner), so it works when nobody can sign in. Running registries pick up a reset setting
 * within a minute. Every command is recorded in the instance audit log.
 *
 *   tsx scripts/harmoniq-admin.ts grant-admin ops@example.com
 *   tsx scripts/harmoniq-admin.ts reset-setting auth
 *   tsx scripts/harmoniq-admin.ts revoke-sessions someone@example.com
 *   tsx scripts/harmoniq-admin.ts list-admins
 *   tsx scripts/harmoniq-admin.ts encryption-status
 *   tsx scripts/harmoniq-admin.ts reseal-secrets
 *
 * In the registry image: `docker run --rm -e SYSTEM_DATABASE_URL=… harmoniq/registry
 * npx tsx scripts/harmoniq-admin.ts <command>`.
 */
import { PrismaClient } from '@prisma/client';
import {
  grantAdmin,
  listAdmins,
  resetSetting,
  revokeSessions,
} from '../src/services/adminRecovery';
import { loadConfig } from '../src/config';
import { resealAll, sealedValueReport } from '../src/services/reseal';

const USAGE = `Usage: harmoniq-admin <command>

  grant-admin <email>       Make this account an instance admin (created if it doesn't exist)
  reset-setting <key>       Drop a setting saved in the admin panel (storage, email, auth, branding)
  revoke-sessions <email>   End every session of this account
  list-admins               List instance admins and the sign-in methods they have used
  encryption-status         Sealed values per encryption key (INST-26)
  reseal-secrets            Re-seal every value with the first key of HARMONIQ_ENCRYPTION_KEYS`;

async function main(argv: string[]) {
  const [command, arg] = argv;
  const url = process.env.SYSTEM_DATABASE_URL;
  if (!url) throw new Error('SYSTEM_DATABASE_URL is required (the schema owner connection)');
  const needsArg = ['grant-admin', 'reset-setting', 'revoke-sessions'];
  if (!command || (needsArg.includes(command) && !arg)) {
    console.error(USAGE);
    process.exit(2);
  }

  const db = new PrismaClient({ datasources: { db: { url } } });
  try {
    switch (command) {
      case 'grant-admin': {
        const { email } = await grantAdmin(db, arg);
        console.log(`${email} is an instance admin. They sign in with this email address.`);
        break;
      }
      case 'reset-setting': {
        const { reset } = await resetSetting(db, arg);
        console.log(
          reset
            ? `Reset "${arg}" to the environment's value (running registries apply it within a minute).`
            : `"${arg}" was not set in the database; nothing to do.`
        );
        break;
      }
      case 'revoke-sessions': {
        const { revoked } = await revokeSessions(db, arg);
        console.log(`Ended ${revoked} session(s); access tokens expire within 15 minutes.`);
        break;
      }
      case 'list-admins':
        console.table(
          (await listAdmins(db)).map((a) => ({
            email: a.email,
            lastLoginAt: a.lastLoginAt?.toISOString() ?? 'never',
            signInMethods: a.signInMethods.join(', ') || '—',
          }))
        );
        break;
      case 'encryption-status': {
        // The keyring comes from the same variables as the registry's.
        const { encryptionKey } = loadConfig(process.env);
        const report = await sealedValueReport(db, encryptionKey);
        console.table(report.keys);
        console.log(
          `Sealed before key ids: ${report.legacy}. Not on the active key: ${report.stale}.`
        );
        for (const u of report.unknownKeys) {
          console.log(`Key ${u.id} is not configured: ${u.values} value(s) can't be opened.`);
        }
        break;
      }
      case 'reseal-secrets': {
        const { encryptionKey } = loadConfig(process.env);
        const result = await resealAll(db, encryptionKey);
        console.log(`Re-sealed ${result.resealed} value(s) with the active key.`, result.byModel);
        break;
      }
      default:
        console.error(USAGE);
        process.exit(2);
    }
  } finally {
    await db.$disconnect();
  }
}

main(process.argv.slice(2)).catch((err) => {
  console.error((err as Error).message);
  process.exit(1);
});
