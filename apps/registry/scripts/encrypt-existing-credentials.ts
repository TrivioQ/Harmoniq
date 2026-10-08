/**
 * One-off: encrypt workspace storage credentials saved before encryption at rest existed.
 * Idempotent — rows already encrypted are skipped.
 *
 *   pnpm --filter @harmoniq/registry exec tsx scripts/encrypt-existing-credentials.ts [--dry-run]
 *
 * Requires SYSTEM_DATABASE_URL and the same HARMONIQ_ENCRYPTION_KEY the registry runs with.
 */
import { createDbClients } from '@harmoniq/db';
import { loadConfig } from '../src/config';
import { encryptJson, isEncryptedValue } from '../src/services/crypto';

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  const { encryptionKey } = loadConfig();
  const { db, systemDb } = createDbClients();

  try {
    const rows = await systemDb.workspaceStorageConfig.findMany();
    const plaintext = rows.filter((row) => !isEncryptedValue(row.credentialsEncrypted));
    console.log(`${rows.length} storage configs, ${plaintext.length} with plaintext credentials`);

    for (const row of plaintext) {
      if (dryRun) {
        console.log(`would encrypt workspace ${row.workspaceId}`);
        continue;
      }
      await systemDb.workspaceStorageConfig.update({
        where: { id: row.id },
        data: { credentialsEncrypted: { ...encryptJson(row.credentialsEncrypted, encryptionKey) } },
      });
      console.log(`encrypted workspace ${row.workspaceId}`);
    }
  } finally {
    await Promise.all([db.$disconnect(), systemDb.$disconnect()]);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
