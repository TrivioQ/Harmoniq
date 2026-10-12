// Copyright The Harmoniq Authors
// SPDX-License-Identifier: Apache-2.0

import { getTranslations } from 'next-intl/server';
import { Link } from '@/i18n/routing';

/** SES-03: after the first factor, a code from the authenticator app or a recovery code. */
export default async function MfaPage(props: { searchParams: Promise<{ error?: string }> }) {
  const t = await getTranslations('MfaPage');
  const { error } = await props.searchParams;

  return (
    <div className="flex min-h-screen items-center justify-center bg-muted/50 p-6">
      <div className="w-full max-w-sm bg-card border rounded-xl shadow-sm p-6 space-y-4">
        <h1 className="font-semibold text-2xl">{t('title')}</h1>
        <p className="text-sm text-muted-foreground">{t('description')}</p>
        {error && (
          <p role="alert" className="text-sm text-red-700">
            {t('invalid')}
          </p>
        )}
        <form action="/api/auth/mfa" method="post" className="space-y-3">
          <input
            name="code"
            required
            autoFocus
            autoComplete="one-time-code"
            inputMode="text"
            maxLength={32}
            placeholder="123456"
            aria-label={t('code')}
            className="w-full rounded-md border px-3 py-2 text-lg tracking-widest font-mono"
          />
          <button
            type="submit"
            className="w-full rounded-md bg-primary text-primary-foreground px-4 py-2 text-sm font-medium"
          >
            {t('verify')}
          </button>
        </form>
        <p className="text-xs text-muted-foreground">{t('recoveryHint')}</p>
        <Link href="/auth/login" className="text-sm text-primary hover:underline">
          {t('back')}
        </Link>
      </div>
    </div>
  );
}
