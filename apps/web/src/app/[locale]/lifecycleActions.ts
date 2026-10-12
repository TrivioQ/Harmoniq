// Copyright The Harmoniq Authors
// SPDX-License-Identifier: Apache-2.0

'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import type { ActionResult } from '@/lib/actionResult';
import { RegistryError, authedFetch } from '@/lib/registry';

// TLC-01/02: deleting and restoring workspaces. The registry authorizes and audits both.

const enc = encodeURIComponent;

async function failure(err: unknown): Promise<ActionResult> {
  const t = await getTranslations('Actions');
  return {
    status: 'error',
    message: err instanceof RegistryError ? err.message : t('unexpectedError'),
  };
}

/** An owner deletes the workspace (the slug typed back); then back to the home page. */
export async function deleteWorkspaceAction(
  workspace: string,
  _prev: ActionResult,
  form: FormData
): Promise<ActionResult> {
  const confirm = String(form.get('confirm') ?? '').trim();
  try {
    await authedFetch(`/api/workspaces/${enc(workspace)}?confirm=${enc(confirm)}`, {
      method: 'DELETE',
    });
  } catch (err) {
    return failure(err);
  }
  revalidatePath('/', 'layout');
  redirect('/');
}

/** An owner or org admin restores a deleted workspace before the purge. */
export async function restoreWorkspaceAction(
  workspace: string,
  _prev: ActionResult
): Promise<ActionResult> {
  const t = await getTranslations('Actions');
  try {
    await authedFetch(`/api/workspaces/${enc(workspace)}/restore`, { method: 'POST', body: {} });
  } catch (err) {
    return failure(err);
  }
  revalidatePath('/', 'layout');
  return { status: 'success', message: t('workspaceRestored', { workspace }) };
}

// ─── Ownership transfers (TLC-06) ───────────────────────────────────────────

/** An owner proposes handing the workspace to a member, who must accept. */
export async function transferWorkspaceAction(
  workspace: string,
  _prev: ActionResult,
  form: FormData
): Promise<ActionResult> {
  const t = await getTranslations('Actions');
  const email = String(form.get('email') ?? '').trim();
  try {
    await authedFetch(`/api/workspaces/${enc(workspace)}/transfer`, { body: { email } });
  } catch (err) {
    return failure(err);
  }
  revalidatePath('/', 'layout');
  return { status: 'success', message: t('transferProposed', { email }) };
}

export async function acceptTransferAction(id: string, _prev: ActionResult): Promise<ActionResult> {
  const t = await getTranslations('Actions');
  try {
    await authedFetch(`/api/transfers/${enc(id)}/accept`, { method: 'POST', body: {} });
  } catch (err) {
    return failure(err);
  }
  revalidatePath('/', 'layout');
  return { status: 'success', message: t('transferAccepted') };
}

export async function cancelTransferAction(id: string, _prev: ActionResult): Promise<ActionResult> {
  const t = await getTranslations('Actions');
  try {
    await authedFetch(`/api/transfers/${enc(id)}/cancel`, { method: 'POST', body: {} });
  } catch (err) {
    return failure(err);
  }
  revalidatePath('/', 'layout');
  return { status: 'success', message: t('transferCancelled') };
}
