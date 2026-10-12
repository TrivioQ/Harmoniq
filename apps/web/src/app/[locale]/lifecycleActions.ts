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
