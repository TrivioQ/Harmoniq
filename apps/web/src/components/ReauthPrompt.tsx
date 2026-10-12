// Copyright The Harmoniq Authors
// SPDX-License-Identifier: Apache-2.0

'use client';

import { useActionState } from 'react';
import { useTranslations } from 'next-intl';
import { reauthAction } from '@/app/[locale]/account/actions';

/**
 * INST-32: shown when a destructive admin action needs a recent re-authentication. A code
 * from the authenticator app (or a recovery code) renews it; then the action is submitted
 * again. Without MFA the only way is to sign in again.
 */
export function ReauthPrompt() {
  const t = useTranslations('Reauth');
  const [state, action, pending] = useActionState(reauthAction, { status: 'idle' });

  if (state.status === 'success') {
    return (
      <p role="status" className="text-sm text-green-700">
        {t('done')}
      </p>
    );
  }
  return (
    <div className="mt-2 space-y-1">
      <form
        action={action}
        role="dialog"
        aria-label={t('title')}
        className="space-y-2 rounded-md border border-amber-300 bg-amber-50 p-3 text-sm"
      >
        <p className="font-medium text-amber-900">{t('title')}</p>
        <p className="text-amber-900">{t('description')}</p>
        <div className="flex gap-2">
          <input
            name="code"
            required
            autoComplete="one-time-code"
            inputMode="text"
            minLength={6}
            maxLength={32}
            aria-label={t('code')}
            placeholder="123456"
            className="rounded-md border px-3 py-1.5 text-sm w-40"
          />
          <button
            type="submit"
            disabled={pending}
            className="inline-flex items-center rounded-md px-3 py-1.5 text-sm font-medium bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
          >
            {t('confirm')}
          </button>
        </div>
        {state.status === 'error' && (
          <p role="alert" className="text-red-700">
            {state.message}
          </p>
        )}
      </form>
      <SignInAgain hint={t('noMfa')} label={t('signInAgain')} />
    </div>
  );
}

/** Without MFA, a fresh sign-in is the re-authentication. */
function SignInAgain({ hint, label }: { hint: string; label: string }) {
  return (
    <form action="/api/auth/logout" method="post" className="text-xs text-amber-800">
      {hint}{' '}
      <button type="submit" className="underline">
        {label}
      </button>
    </form>
  );
}
