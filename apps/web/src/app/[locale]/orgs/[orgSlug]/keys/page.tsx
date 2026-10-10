// Copyright The Harmoniq Authors
// SPDX-License-Identifier: Apache-2.0

import { getFormatter, getTranslations } from 'next-intl/server';
import { ActionForm } from '@/components/ActionForm';
import { orgApi } from '@/lib/orgApi';
import { createOrgKeyAction, revokeOrgKeyAction } from '../../actions';

const SCOPES = ['manifest:read', 'deploy:write', 'admin'] as const;

/** ORG-13: keys for CI shared across the organization's teams. */
export default async function OrgKeysPage(props: { params: Promise<{ orgSlug: string }> }) {
  const { orgSlug } = await props.params;
  const t = await getTranslations('OrgKeys');
  const format = await getFormatter();
  const { keys } = await orgApi.keys(orgSlug);

  return (
    <>
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">{t('title')}</h1>
        <p className="text-sm text-muted-foreground">{t('description')}</p>
      </div>
      <section className="rounded-xl border bg-card p-4 space-y-2">
        <ActionForm
          action={createOrgKeyAction.bind(null, orgSlug)}
          submitLabel={t('create')}
          secretHint={t('copyOnce')}
        >
          <input
            name="name"
            required
            placeholder="Shared CI"
            aria-label={t('name')}
            className="block w-full max-w-sm rounded-md border px-3 py-1.5 text-sm"
          />
          <fieldset className="flex gap-4 text-sm">
            <legend className="sr-only">{t('scopes')}</legend>
            {SCOPES.map((scope) => (
              <label key={scope} className="flex items-center gap-1">
                <input
                  type="checkbox"
                  name="scopes"
                  value={scope}
                  defaultChecked={scope === 'deploy:write'}
                />
                <code>{scope}</code>
              </label>
            ))}
          </fieldset>
          <input
            name="workspaces"
            placeholder={t('workspacesPlaceholder')}
            aria-label={t('workspaces')}
            className="block w-full max-w-sm rounded-md border px-3 py-1.5 text-sm font-mono"
          />
        </ActionForm>
      </section>
      <section className="rounded-xl border bg-card divide-y">
        {keys.map((k) => (
          <div key={k.id} className="p-3 flex flex-wrap items-center justify-between gap-2 text-sm">
            <div>
              <div className="font-medium">
                {k.name} <code className="text-xs text-muted-foreground">{k.prefix}…</code>
              </div>
              <div className="text-xs text-muted-foreground">
                {k.scopes.join(', ')} ·{' '}
                {k.workspaces.length ? k.workspaces.join(', ') : t('allWorkspaces')}
                {k.lastUsedAt &&
                  ` · ${t('lastUsed', { when: format.relativeTime(new Date(k.lastUsedAt)) })}`}
              </div>
            </div>
            {k.revokedAt ? (
              <span className="text-xs text-muted-foreground">{t('revoked')}</span>
            ) : (
              <ActionForm
                action={revokeOrgKeyAction.bind(null, orgSlug, k.id)}
                submitLabel={t('revoke')}
                confirm={t('revokeConfirm', { name: k.name })}
                variant="danger"
              />
            )}
          </div>
        ))}
        {keys.length === 0 && <p className="p-4 text-sm text-muted-foreground">{t('empty')}</p>}
      </section>
    </>
  );
}
