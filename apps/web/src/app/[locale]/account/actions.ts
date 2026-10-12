// Copyright The Harmoniq Authors
// SPDX-License-Identifier: Apache-2.0

'use server';

import { revalidatePath } from 'next/cache';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import type { SessionResponse } from '@harmoniq/core/dist/schemas/AuthSchemas';
import type { ActionResult } from '@/lib/actionResult';
import { RegistryError, authedFetch } from '@/lib/registry';
import { MFA_SETUP_COOKIE, REFRESH_COOKIE, setSessionCookies } from '@/lib/session';
import { isProductionEnv } from '@/lib/env';

// SES-02/03: the signed-in user's sessions and second factor.

const enc = encodeURIComponent;

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

const code = (form: FormData) => String(form.get('code') ?? '').trim();
/** Recovery codes, one per line in the shown-once box. */
const listed = (codes: string[]) => codes.join('   ');

export async function endSessionAction(id: string, _prev: ActionResult) {
  return run(
    () => authedFetch(`/api/me/sessions/${enc(id)}`, { method: 'DELETE' }),
    (t) => ({ status: 'success', message: t('sessionEnded') })
  );
}

export async function endOtherSessionsAction(_prev: ActionResult) {
  return run(
    () => authedFetch<{ ended: number }>('/api/me/sessions', { method: 'DELETE' }),
    (t, r) => ({
      status: 'success',
      message: t('sessionsEnded', { count: (r as { ended: number }).ended }),
    })
  );
}

/** Starts enrolment: the secret goes to an HttpOnly cookie for the setup page. */
export async function startMfaSetupAction(_prev: ActionResult): Promise<ActionResult> {
  const t = await getTranslations('Actions');
  let setup: { secret: string; otpauthUrl: string };
  try {
    setup = await authedFetch('/api/me/mfa/setup', { method: 'POST', body: {} });
  } catch (err) {
    return {
      status: 'error',
      message: err instanceof RegistryError ? err.message : t('unexpectedError'),
    };
  }
  (await cookies()).set(MFA_SETUP_COOKIE, JSON.stringify(setup), {
    httpOnly: true,
    secure: isProductionEnv(),
    sameSite: 'lax',
    path: '/',
    maxAge: 10 * 60,
  });
  redirect('/account/mfa');
}

/** Confirms the app with a code; this session becomes verified; recovery codes shown once. */
export async function enableMfaAction(_prev: ActionResult, form: FormData): Promise<ActionResult> {
  const store = await cookies();
  const refreshToken = store.get(REFRESH_COOKIE)?.value;
  return run(
    async () => {
      const result = await authedFetch<{
        recoveryCodes: string[];
        session: SessionResponse | null;
      }>('/api/me/mfa/enable', { body: { code: code(form), refreshToken } });
      if (result.session) setSessionCookies(store, result.session);
      store.set(MFA_SETUP_COOKIE, '', { path: '/', maxAge: 0 });
      return result;
    },
    (t, r) => ({
      status: 'success',
      message: t('mfaEnabled'),
      secret: listed((r as { recoveryCodes: string[] }).recoveryCodes),
    })
  );
}

export async function newRecoveryCodesAction(
  _prev: ActionResult,
  form: FormData
): Promise<ActionResult> {
  return run(
    () => authedFetch('/api/me/mfa/recovery-codes', { body: { code: code(form) } }),
    (t, r) => ({
      status: 'success',
      message: t('recoveryCodesReplaced'),
      secret: listed((r as { recoveryCodes: string[] }).recoveryCodes),
    })
  );
}

export async function disableMfaAction(_prev: ActionResult, form: FormData) {
  return run(
    () => authedFetch('/api/me/mfa', { method: 'DELETE', body: { code: code(form) } }),
    (t) => ({ status: 'success', message: t('mfaDisabled') })
  );
}
