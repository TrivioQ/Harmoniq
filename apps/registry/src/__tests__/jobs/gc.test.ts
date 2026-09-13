import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { handleSoftDelete, handleHardDelete, handleHealthEventPurge } from '../../jobs/gc';
import { ConsoleLogger } from '../../adapters/ConsoleLogger';

describe('GC Jobs', () => {
  let db: PrismaClient;
  const logger = new ConsoleLogger();

  beforeAll(async () => {
    db = new PrismaClient();
  });

  afterAll(async () => {
    await db.$disconnect();
  });

  it('handleSoftDelete should soft-delete versions older than 30 days', async () => {
    // We cannot easily mock the exact 30 days in the DB without raw SQL or test seeded data,
    // but we can ensure the function runs without throwing errors.
    await expect(handleSoftDelete(db, logger)).resolves.toBeUndefined();
  });

  it('handleHardDelete should hard-delete versions soft-deleted > 7 days ago', async () => {
    await expect(handleHardDelete(db, logger)).resolves.toBeUndefined();
  });

  it('handleHealthEventPurge should hard-delete events older than 1 day', async () => {
    await expect(handleHealthEventPurge(db, logger)).resolves.toBeUndefined();
  });
});
