// Copyright The Harmoniq Authors
// SPDX-License-Identifier: Apache-2.0

'use server';

import { getTranslations } from 'next-intl/server';
import type { ActionResult } from '@/lib/actionResult';
import { RegistryError, registryFetch } from '@/lib/registry';

/** INST-30: the new address confirms an email change an instance admin started. */
export async function confirmEmailChangeAction(
  _prev: ActionResult,
  form: FormData
): Promise<ActionResult> {
  const t = await getTranslations('EmailChangePage');
  try {
    const { email } = await registryFetch<{ email: string }>('/api/auth/email-change', {
      body: { token: String(form.get('token') ?? '') },
    });
    return { status: 'success', message: t('done', { email }) };
  } catch (err) {
    return {
      status: 'error',
      message: err instanceof RegistryError ? err.message : t('failed'),
    };
  }
}
