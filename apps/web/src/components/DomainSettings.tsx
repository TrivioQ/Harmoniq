// Copyright The Harmoniq Authors
// SPDX-License-Identifier: Apache-2.0

import { getFormatter, getTranslations } from 'next-intl/server';
import { ActionForm } from '@/components/ActionForm';
import { CopyButton } from '@/components/CopyButton';
import { authedFetch } from '@/lib/registry';
import {
  type SsoOwner,
  claimDomainAction,
  removeDomainAction,
  verifyDomainAction,
} from '@/app/[locale]/ssoActions';

export interface DomainClaim {
  domain: string;
  verified: boolean;
  verifiedAt: string | null;
  lastCheckedAt: string | null;
  failingSince: string | null;
  record: { type: 'TXT'; name: string; value: string };
}

/**
 * DOM-01..05: domains the workspace or organization proved with DNS. Single sign-on only
 * trusts emails, auto-joins users and routes "Sign in with SSO" for verified domains.
 */
export async function DomainSettings({
  owner,
  trusted,
}: {
  owner: SsoOwner;
  /** Trusted domains from the SSO settings, to point out unverified ones. */
  trusted: string[];
}) {
  const t = await getTranslations('DomainSettings');
  const format = await getFormatter();
  const base =
    owner.kind === 'workspace'
      ? `/api/workspaces/${encodeURIComponent(owner.slug)}`
      : `/api/orgs/${encodeURIComponent(owner.slug)}`;
  const { domains } = await authedFetch<{ domains: DomainClaim[] }>(`${base}/domains`);
  const verified = new Set(domains.filter((d) => d.verified).map((d) => d.domain));
  const unverifiedTrusted = [...new Set(trusted.map((d) => d.toLowerCase()))].filter(
    (d) => !verified.has(d)
  );

  return (
    <section className="rounded-xl border bg-card p-4 space-y-3 max-w-3xl">
      <div>
        <h2 className="font-semibold text-sm">{t('title')}</h2>
        <p className="text-xs text-muted-foreground">{t('description')}</p>
      </div>
      {unverifiedTrusted.length > 0 && (
        <p className="rounded-md bg-amber-50 p-2 text-xs text-amber-900">
          {t('unverifiedTrusted', { domains: unverifiedTrusted.join(', ') })}
        </p>
      )}
      <ul className="divide-y text-sm">
        {domains.map((d) => (
          <li key={d.domain} className="py-2 space-y-1">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="font-mono">
                {d.domain}{' '}
                {d.verified ? (
                  <span className="ml-1 rounded bg-green-100 px-1.5 py-0.5 text-xs text-green-800">
                    {t('verified')}
                  </span>
                ) : (
                  <span className="ml-1 rounded bg-gray-100 px-1.5 py-0.5 text-xs text-gray-700">
                    {t('pending')}
                  </span>
                )}
              </span>
              <span className="flex gap-2">
                {!d.verified && (
                  <ActionForm
                    action={verifyDomainAction.bind(null, owner, d.domain)}
                    submitLabel={t('verify')}
                    variant="outline"
                  />
                )}
                <ActionForm
                  action={removeDomainAction.bind(null, owner, d.domain)}
                  submitLabel={t('remove')}
                  variant="danger"
                  confirm={t('removeConfirm', { domain: d.domain })}
                />
              </span>
            </div>
            {d.failingSince && (
              <p className="text-xs text-red-700">
                {t('failing', { since: format.dateTime(new Date(d.failingSince), 'short') })}
              </p>
            )}
            {(!d.verified || d.failingSince) && (
              <div className="text-xs text-muted-foreground space-y-1">
                <p>{t('instructions')}</p>
                <div className="flex flex-wrap items-center gap-2 font-mono">
                  <span>TXT</span>
                  <span>{d.record.name}</span>
                  <span className="break-all">{d.record.value}</span>
                  <CopyButton text={d.record.value} label={t('copy')} copiedLabel={t('copied')} />
                </div>
              </div>
            )}
          </li>
        ))}
        {domains.length === 0 && <li className="py-2 text-muted-foreground">{t('empty')}</li>}
      </ul>
      <ActionForm
        action={claimDomainAction.bind(null, owner)}
        submitLabel={t('add')}
        className="flex flex-wrap gap-2"
      >
        <input
          name="domain"
          required
          placeholder="example.com"
          aria-label={t('domain')}
          className="rounded-md border px-3 py-1.5 text-sm font-mono"
        />
      </ActionForm>
    </section>
  );
}
