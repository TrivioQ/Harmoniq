'use server';

import { revalidatePath } from 'next/cache';
import { getTranslations } from 'next-intl/server';
import type { ActionResult } from '@/lib/actionResult';
import { RegistryError, authedFetch } from '@/lib/registry';

// INST-07..10: every change goes through the registry's admin API, which checks the
// instance admin and records it (INST-18).

const enc = encodeURIComponent;
const field = (form: FormData, name: string) => String(form.get(name) ?? '').trim();

async function run(
  call: () => Promise<unknown>,
  success: (t: Awaited<ReturnType<typeof getTranslations>>, result: unknown) => ActionResult
): Promise<ActionResult> {
  const t = await getTranslations('Actions');
  try {
    const result = await call();
    revalidatePath('/', 'layout');
    return success(t, result);
  } catch (err) {
    return {
      status: 'error',
      message: err instanceof RegistryError ? err.message : t('unexpectedError'),
    };
  }
}

export async function suspendWorkspaceAction(
  slug: string,
  _prev: ActionResult,
  form: FormData
): Promise<ActionResult> {
  return run(
    () =>
      authedFetch(`/api/admin/workspaces/${enc(slug)}/suspend`, {
        body: { reason: field(form, 'reason') || undefined },
      }),
    (t) => ({ status: 'success', message: t('workspaceSuspended') })
  );
}

export async function unsuspendWorkspaceAction(slug: string, _prev: ActionResult) {
  return run(
    () => authedFetch(`/api/admin/workspaces/${enc(slug)}/unsuspend`, { method: 'POST' }),
    (t) => ({ status: 'success', message: t('workspaceUnsuspended') })
  );
}

export async function deleteWorkspaceAction(
  slug: string,
  _prev: ActionResult,
  form: FormData
): Promise<ActionResult> {
  return run(
    () =>
      authedFetch(`/api/admin/workspaces/${enc(slug)}?confirm=${enc(field(form, 'confirm'))}`, {
        method: 'DELETE',
      }),
    (t) => ({ status: 'success', message: t('workspaceDeleted') })
  );
}

export async function revokeSessionsAction(userId: string, _prev: ActionResult) {
  return run(
    () => authedFetch(`/api/admin/users/${enc(userId)}/revoke-sessions`, { method: 'POST' }),
    (t, r) => ({
      status: 'success',
      message: t('sessionsRevoked', { count: (r as { revoked: number }).revoked }),
    })
  );
}

export async function deleteUserAction(
  userId: string,
  _prev: ActionResult,
  form: FormData
): Promise<ActionResult> {
  return run(
    () =>
      authedFetch(`/api/admin/users/${enc(userId)}?confirm=${enc(field(form, 'confirm'))}`, {
        method: 'DELETE',
      }),
    (t) => ({ status: 'success', message: t('userDeleted') })
  );
}

export async function grantAdminAction(_prev: ActionResult, form: FormData) {
  return run(
    () => authedFetch('/api/admin/admins', { body: { email: field(form, 'email') } }),
    (t) => ({ status: 'success', message: t('adminGranted') })
  );
}

export async function revokeAdminAction(userId: string, _prev: ActionResult) {
  return run(
    () => authedFetch(`/api/admin/admins/${enc(userId)}`, { method: 'DELETE' }),
    (t) => ({ status: 'success', message: t('adminRevoked') })
  );
}
