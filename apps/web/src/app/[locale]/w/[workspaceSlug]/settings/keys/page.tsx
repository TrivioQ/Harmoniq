// Copyright The Harmoniq Authors
// SPDX-License-Identifier: Apache-2.0

import { getFormatter, getTranslations } from 'next-intl/server';
import { ActionForm } from '@/components/ActionForm';
import { workspaceApi } from '@/lib/workspaceApi';
import { createApiKeyAction, revokeApiKeyAction, rotateApiKeyAction } from '../../actions';

const SCOPES = ['manifest:read', 'deploy:write', 'admin'] as const;

export default async function ApiKeysPage(props: { params: Promise<{ workspaceSlug: string }> }) {
  const { workspaceSlug } = await props.params;
  const t = await getTranslations('ApiKeysPage');
  const format = await getFormatter();
  const { keys } = await workspaceApi.apiKeys(workspaceSlug);

  return (
    <div className="space-y-6">
      <section className="rounded-xl border bg-card p-6 space-y-3">
        <h3 className="font-semibold">{t('create')}</h3>
        <p className="text-sm text-muted-foreground">{t('description')}</p>
        <ActionForm
          action={createApiKeyAction.bind(null, workspaceSlug)}
          submitLabel={t('createSubmit')}
          secretHint={t('copyOnce')}
        >
          <input
            name="name"
            required
            placeholder="GitHub Actions"
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
                <span className="font-mono">{scope}</span>
              </label>
            ))}
          </fieldset>
        </ActionForm>
      </section>

      <ul className="rounded-xl border bg-card divide-y">
        {keys.map((key) => {
          const revoked = key.status === 'revoked' || key.status === 'expired';
          return (
            <li key={key.id} className="p-4 flex flex-wrap items-center justify-between gap-4">
              <div className={revoked ? 'opacity-50' : ''}>
                <div className="font-medium">
                  {key.name}{' '}
                  <span className="font-mono text-xs text-muted-foreground">{key.prefix}…</span>
                </div>
                <div className="text-xs text-muted-foreground">
                  {key.scopes.join(', ')} ·{' '}
                  {key.lastUsedAt
                    ? t('lastUsed', { when: format.relativeTime(new Date(key.lastUsedAt)) })
                    : t('neverUsed')}
                  {revoked && ` · ${t('revoked')}`}
                  {key.status === 'rotating' &&
                    key.gracePeriodEnd &&
                    ` · ${t('expiresAfterRotation', { when: format.relativeTime(new Date(key.gracePeriodEnd)) })}`}
                </div>
                {!!key.policyViolations?.length && (
                  <div className="mt-1 text-xs text-amber-800">
                    {t('policyViolation', { problems: key.policyViolations.join('; ') })}
                  </div>
                )}
              </div>
              {!revoked && (
                <div className="flex gap-2">
                  <ActionForm
                    action={rotateApiKeyAction.bind(null, workspaceSlug, key.id)}
                    submitLabel={t('rotate')}
                    variant="outline"
                    confirm={t('rotateConfirm')}
                    secretHint={t('copyOnce')}
                  />
                  <ActionForm
                    action={revokeApiKeyAction.bind(null, workspaceSlug, key.id)}
                    submitLabel={t('revoke')}
                    variant="danger"
                    confirm={t('revokeConfirm', { name: key.name })}
                  />
                </div>
              )}
            </li>
          );
        })}
        {keys.length === 0 && <li className="p-6 text-sm text-muted-foreground">{t('empty')}</li>}
      </ul>
    </div>
  );
}
