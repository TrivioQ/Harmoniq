// Copyright The Harmoniq Authors
// SPDX-License-Identifier: Apache-2.0

import { getFormatter, getTranslations } from 'next-intl/server';
import { Link } from '@/i18n/routing';
import { ActionForm } from '@/components/ActionForm';
import { getMe, registryFetch } from '@/lib/registry';
import { acceptInvitationAction } from '../../lifecycleActions';

interface InvitationInfo {
  email: string;
  role: string;
  status: 'pending' | 'accepted' | 'revoked' | 'expired';
  expiresAt: string;
  kind: 'workspace' | 'organization';
  target: { slug: string; name: string } | null;
}

/**
 * PPL-02: the link from an invitation email. Signed in with the invited address, you
 * accept here; otherwise signing in with it accepts the invitation automatically.
 */
export default async function InvitePage(props: { params: Promise<{ token: string }> }) {
  const { token } = await props.params;
  const t = await getTranslations('InvitePage');
  const format = await getFormatter();
  const info = await registryFetch<InvitationInfo>(
    `/api/invitations/${encodeURIComponent(token)}`
  ).catch(() => null);
  const me = info ? await getMe() : null;
  const usable = info?.status === 'pending' && info.target;

  return (
    <div className="flex min-h-screen items-center justify-center bg-muted/30 p-6">
      <div className="w-full max-w-md space-y-4 rounded-xl border bg-card p-6">
        <h1 className="text-xl font-semibold">{t('title')}</h1>
        {!info ? (
          <p className="text-sm text-muted-foreground">{t('notFound')}</p>
        ) : !usable ? (
          <p className="text-sm text-muted-foreground">{t(`status_${info.status}`)}</p>
        ) : (
          <>
            <p className="text-sm">
              {t(info.kind === 'workspace' ? 'toWorkspace' : 'toOrganization', {
                name: info.target!.name,
                role: info.role,
              })}
            </p>
            <p className="text-xs text-muted-foreground">
              {t('expires', { date: format.dateTime(new Date(info.expiresAt), 'short') })}
            </p>
            {!me ? (
              <>
                <p className="text-sm">{t('signInAs', { email: info.email })}</p>
                <Link href="/auth/login" className="text-sm underline hover:text-primary">
                  {t('signIn')}
                </Link>
              </>
            ) : me.user.email.toLowerCase() !== info.email ? (
              <p className="text-sm text-red-700">
                {t('wrongAccount', { email: info.email, current: me.user.email })}
              </p>
            ) : (
              <ActionForm
                action={acceptInvitationAction.bind(null, token)}
                submitLabel={t('accept')}
              />
            )}
          </>
        )}
      </div>
    </div>
  );
}
