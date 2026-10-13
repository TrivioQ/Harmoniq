// Copyright The Harmoniq Authors
// SPDX-License-Identifier: Apache-2.0

import { getTranslations } from 'next-intl/server';
import { ActionForm } from '@/components/ActionForm';
import { Link } from '@/i18n/routing';
import { confirmEmailChangeAction } from './actions';

// INST-30: landing page of the confirmation link. The change happens on an explicit
// POST, so mail scanners that prefetch links cannot confirm it.
export default async function EmailChangePage(props: {
  searchParams: Promise<{ token?: string }>;
}) {
  const t = await getTranslations('EmailChangePage');
  const { token } = await props.searchParams;
  return (
    <div className="flex min-h-screen items-center justify-center bg-muted/50 p-6">
      <div className="w-full max-w-sm bg-card border rounded-xl shadow-sm p-6 space-y-4">
        <h1 className="font-semibold text-2xl">{t('title')}</h1>
        {token ? (
          <ActionForm action={confirmEmailChangeAction} submitLabel={t('confirm')}>
            <input type="hidden" name="token" value={token} />
            <p className="text-sm text-muted-foreground">{t('description')}</p>
          </ActionForm>
        ) : (
          <p className="text-sm text-muted-foreground">{t('missingToken')}</p>
        )}
        <Link href="/auth/login" className="text-sm text-primary hover:underline">
          {t('signIn')}
        </Link>
      </div>
    </div>
  );
}
