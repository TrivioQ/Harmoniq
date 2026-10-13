// Copyright The Harmoniq Authors
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'crypto';
import { FastifyInstance } from 'fastify';
import { buildApp } from '../app';
import {
  RECOVERY_ACTOR,
  grantAdmin,
  listAdmins,
  resetSetting,
  revokeSessions,
} from '../services/adminRecovery';
import { Fixtures } from './helpers/fixtures';

// INST-24: break-glass recovery without the admin panel.
describe('Admin recovery commands (INST-24)', () => {
  let app: FastifyInstance;
  let fx: Fixtures;
  const created: string[] = [];
  const db = () => app.container.systemDb;
  const lastEvent = (action: string) =>
    db().instanceAuditEvent.findFirst({
      where: { action, actorId: RECOVERY_ACTOR },
      orderBy: { createdAt: 'desc' },
    });

  beforeAll(async () => {
    app = await buildApp();
    await app.ready();
    fx = new Fixtures(app);
  });

  afterAll(async () => {
    await db().user.deleteMany({ where: { id: { in: created } } });
    await db().instanceConfig.deleteMany({ where: { key: 'settings.branding' } });
    await fx.cleanup();
    await app.close();
  });

  it('grants admin to a new account, as a system action', async () => {
    const email = `Recovery-${randomUUID()}@Test.Local`;
    const { userId } = await grantAdmin(db(), email);
    created.push(userId);
    const user = await db().user.findUniqueOrThrow({
      where: { id: userId },
      include: { InstanceAdmin: true },
    });
    expect(user.email).toBe(email.toLowerCase());
    expect(user.InstanceAdmin?.revokedAt).toBeNull();
    expect((await lastEvent('instance.admin_grant'))?.resourceId).toBe(userId);
    expect((await listAdmins(db())).map((a) => a.email)).toContain(user.email);
  });

  it('restores a revoked grant of an existing account', async () => {
    const user = await fx.user({ instanceAdmin: true });
    await db().instanceAdmin.update({
      where: { userId: user.id },
      data: { revokedAt: new Date() },
    });
    await grantAdmin(db(), user.email.toUpperCase());
    const grant = await db().instanceAdmin.findUniqueOrThrow({ where: { userId: user.id } });
    expect(grant.revokedAt).toBeNull();
    expect(grant.grantedBy).toBe(RECOVERY_ACTOR);
  });

  it('rejects input that is not an email', async () => {
    await expect(grantAdmin(db(), 'not-an-email')).rejects.toThrow('Not an email address');
  });

  it('resets a stored setting, and only known ones', async () => {
    await db().instanceConfig.upsert({
      where: { key: 'settings.branding' },
      create: { key: 'settings.branding', value: { name: 'Locked Co' }, updatedBy: 'test' },
      update: { value: { name: 'Locked Co' } },
    });
    expect(await resetSetting(db(), 'branding')).toEqual({ reset: true });
    expect(
      await db().instanceConfig.findUnique({ where: { key: 'settings.branding' } })
    ).toBeNull();
    expect((await lastEvent('instance.config_updated'))?.metadata).toMatchObject({
      key: 'branding',
      reset: true,
    });
    expect(await resetSetting(db(), 'branding')).toEqual({ reset: false });
    await expect(resetSetting(db(), 'setup.completed')).rejects.toThrow('Unknown setting');
  });

  it('ends every session of a user', async () => {
    const user = await fx.user();
    await db().refreshToken.createMany({
      data: [1, 2].map((n) => ({
        userId: user.id,
        tokenHash: `hash-${randomUUID()}-${n}`,
        familyId: randomUUID(),
        expiresAt: new Date(Date.now() + 3_600_000),
      })),
    });
    expect(await revokeSessions(db(), user.email)).toEqual({ revoked: 2 });
    expect(await db().refreshToken.count({ where: { userId: user.id, revokedAt: null } })).toBe(0);
    await expect(revokeSessions(db(), `nobody-${randomUUID()}@test.local`)).rejects.toThrow(
      'No user'
    );
  });
});
