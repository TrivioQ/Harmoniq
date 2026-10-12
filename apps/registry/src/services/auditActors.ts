// Copyright The Harmoniq Authors
// SPDX-License-Identifier: Apache-2.0

import { createHash } from 'crypto';
import type { ActorType, Prisma } from '@prisma/client';
import { BadRequestError } from '@harmoniq/core/dist/errors/AppError';

/**
 * AUD-07: who did it, readable. Users by email, keys by name and prefix. A user who was
 * erased is shown pseudonymously (`deleted user #<hash>`): the same person gets the same
 * hash, without revealing who it was.
 */
export interface Actor {
  type: ActorType;
  id: string;
  label: string;
  /** The user or key no longer exists. */
  deleted: boolean;
}

type Tx = Prisma.TransactionClient;
type Ref = { actorType: ActorType; actorId: string };
export type Actors = Map<string, Actor>;

export const pseudonym = (id: string) =>
  `deleted user #${createHash('sha256').update(id).digest('hex').slice(0, 8)}`;

/**
 * Adds the actors of `refs` that `tx` can see (RLS applies: workspace keys in a workspace
 * scope, org keys in an org scope) to `known`. Call again with another scope for the rest.
 */
export async function resolveActors(tx: Tx, refs: Ref[], known: Actors = new Map()) {
  const missing = (type: ActorType) => [
    ...new Set(
      refs.filter((r) => r.actorType === type && !known.has(r.actorId)).map((r) => r.actorId)
    ),
  ];
  const userIds = missing('user');
  const keyIds = missing('apiKey');
  const [users, keys, orgKeys] = await Promise.all([
    userIds.length
      ? tx.user.findMany({ where: { id: { in: userIds } }, select: { id: true, email: true } })
      : [],
    keyIds.length
      ? tx.apiKey.findMany({
          where: { id: { in: keyIds } },
          select: { id: true, name: true, prefix: true, revokedAt: true },
        })
      : [],
    keyIds.length
      ? tx.orgApiKey.findMany({
          where: { id: { in: keyIds } },
          select: { id: true, name: true, prefix: true, revokedAt: true },
        })
      : [],
  ]);
  for (const u of users) {
    known.set(u.id, { type: 'user', id: u.id, label: u.email, deleted: false });
  }
  for (const k of [...keys, ...orgKeys]) {
    known.set(k.id, {
      type: 'apiKey',
      id: k.id,
      label: `${k.name} (${k.prefix})`,
      deleted: false,
    });
  }
  return known;
}

/** The event's actor, or a placeholder when it could not be resolved. */
export function actorOf(known: Actors, ref: Ref): Actor {
  const found = known.get(ref.actorId);
  if (found) return found;
  switch (ref.actorType) {
    case 'user':
      return { type: 'user', id: ref.actorId, label: pseudonym(ref.actorId), deleted: true };
    case 'apiKey':
      return {
        type: 'apiKey',
        id: ref.actorId,
        label: `deleted key (${ref.actorId.slice(0, 8)})`,
        deleted: true,
      };
    default:
      return { type: ref.actorType, id: ref.actorId, label: ref.actorId, deleted: false };
  }
}

/**
 * AUD-08: the `actor` filter is an id or an email (case-insensitive). An email nobody
 * has matches nothing.
 */
export async function actorWhere(tx: Tx, actor: string | undefined) {
  if (!actor) return {};
  if (!actor.includes('@')) return { actorId: actor };
  const users = await tx.user.findMany({
    where: { email: { equals: actor.trim(), mode: 'insensitive' } },
    select: { id: true },
  });
  return { actorId: { in: users.map((u) => u.id) } };
}

/** `from`/`to` as dates; a malformed date is the caller's mistake, not an empty page. */
export function parseDate(value: string | undefined) {
  if (!value) return undefined;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) throw new BadRequestError(`Invalid date: ${value}`);
  return d;
}
