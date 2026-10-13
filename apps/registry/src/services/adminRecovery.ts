// Copyright The Harmoniq Authors
// SPDX-License-Identifier: Apache-2.0

import type { PrismaClient } from '@prisma/client';
import {
  INSTANCE_SETTING_KEYS,
  InstanceSettingKey,
} from '@harmoniq/core/dist/schemas/InstanceSettingsSchemas';

/**
 * INST-24: break-glass commands for when nobody can use the admin panel (every sign-in
 * method off, the last admin gone). They run with the owner connection, so they work
 * without any session, and each one is recorded as a system action.
 */
export const RECOVERY_ACTOR = 'system:harmoniq-admin';

const normalize = (email: string) => email.trim().toLowerCase();

async function record(
  db: PrismaClient,
  event: { action: string; resourceType: string; resourceId: string; metadata?: object }
) {
  await db.instanceAuditEvent.create({
    data: { actorType: 'system', actorId: RECOVERY_ACTOR, ...event },
  });
}

/** Grants instance admin, creating the account if needed (they sign in with this email). */
export async function grantAdmin(db: PrismaClient, rawEmail: string) {
  const email = normalize(rawEmail);
  if (!/^[^@\s]+@[^@\s]+$/.test(email)) throw new Error(`Not an email address: ${rawEmail}`);
  const user =
    (await db.user.findFirst({ where: { email: { equals: email, mode: 'insensitive' } } })) ??
    (await db.user.create({ data: { email } }));
  await db.instanceAdmin.upsert({
    where: { userId: user.id },
    create: { userId: user.id, grantedBy: RECOVERY_ACTOR },
    update: { revokedAt: null, grantedBy: RECOVERY_ACTOR },
  });
  await record(db, { action: 'instance.admin_grant', resourceType: 'user', resourceId: user.id });
  return { userId: user.id, email: user.email };
}

/** Drops a setting stored in the database, so the environment's value applies again. */
export async function resetSetting(db: PrismaClient, key: string) {
  if (!(INSTANCE_SETTING_KEYS as readonly string[]).includes(key)) {
    throw new Error(`Unknown setting "${key}" (one of: ${INSTANCE_SETTING_KEYS.join(', ')})`);
  }
  const { count } = await db.instanceConfig.deleteMany({ where: { key: `settings.${key}` } });
  if (count) {
    await record(db, {
      action: 'instance.config_updated',
      resourceType: 'instance_config',
      resourceId: key,
      metadata: { key: key as InstanceSettingKey, reset: true },
    });
  }
  return { reset: count > 0 };
}

/** Ends every session of a user (refresh tokens now; access tokens within 15 minutes). */
export async function revokeSessions(db: PrismaClient, rawEmail: string) {
  const user = await db.user.findFirst({
    where: { email: { equals: normalize(rawEmail), mode: 'insensitive' } },
  });
  if (!user) throw new Error(`No user with the email ${rawEmail}`);
  const { count } = await db.refreshToken.updateMany({
    where: { userId: user.id, revokedAt: null },
    data: { revokedAt: new Date() },
  });
  await record(db, {
    action: 'instance.user_sessions_revoke',
    resourceType: 'user',
    resourceId: user.id,
    metadata: { sessions: count },
  });
  return { revoked: count };
}

export async function listAdmins(db: PrismaClient) {
  const grants = await db.instanceAdmin.findMany({
    where: { revokedAt: null },
    include: {
      user: {
        select: { email: true, lastLoginAt: true, Identities: { select: { provider: true } } },
      },
    },
    orderBy: { createdAt: 'asc' },
  });
  return grants.map((g) => ({
    email: g.user.email,
    lastLoginAt: g.user.lastLoginAt,
    signInMethods: [...new Set(g.user.Identities.map((i) => i.provider))],
  }));
}
