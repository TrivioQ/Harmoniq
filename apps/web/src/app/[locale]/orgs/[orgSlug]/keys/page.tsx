// Copyright The Harmoniq Authors
// SPDX-License-Identifier: Apache-2.0

import { getFormatter, getTranslations } from 'next-intl/server';
import { ActionForm } from '@/components/ActionForm';
import { orgApi } from '@/lib/orgApi';
import { createOrgKeyAction, revokeOrgKeyAction, rotateOrgKeyAction } from '../../actions';

const SCOPES = ['manifest:read', 'deploy:write', 'admin'] as const;
const input = 'block w-full max-w-sm rounded-md border px-3 py-1.5 text-sm';
const BADGE: Record<string, string> = {
  rotating: 'bg-amber-100 text-amber-900',
  expired: 'bg-muted text-muted-foreground',
  revoked: 'bg-muted text-muted-foreground',
};

/** ORG-13, TAD-05: keys for CI shared across the organization's teams. */
export default async function OrgKeysPage(props: { params: Promise<{ orgSlug: string }> }) {
  const { orgSlug } = await props.params;
  const t = await getTranslations('OrgKeys');
  const format = await getFormatter();
  const [{ keys }, catalog] = await Promise.all([
    orgApi.keys(orgSlug),
    orgApi.catalog(orgSlug, { limit: '200' }).catch(() => ({ modules: [] })),
  ]);
  const moduleName = new Map(catalog.modules.map((m) => [m.id, `${m.workspace}/${m.slug}`]));

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
            className={input}
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
            className={`${input} font-mono`}
          />
          {catalog.modules.length > 0 && (
            <label className="block text-xs text-muted-foreground">
              {t('modules')}
              <select name="moduleIds" multiple size={4} className={`${input} font-mono`}>
                {catalog.modules.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.workspace}/{m.slug}
                  </option>
                ))}
              </select>
              <span>{t('modulesHint')}</span>
            </label>
          )}
          <label className="block text-xs text-muted-foreground">
            {t('expires')}
            <input name="expiresAt" type="date" className={input} />
          </label>
        </ActionForm>
      </section>
      <section className="rounded-xl border bg-card divide-y">
        {keys.map((k) => {
          const status = k.status ?? (k.revokedAt ? 'revoked' : 'active');
          const live = status === 'active' || status === 'rotating';
          return (
            <div
              key={k.id}
              className="p-3 flex flex-wrap items-start justify-between gap-2 text-sm"
            >
              <div className="space-y-0.5">
                <div className="font-medium flex items-center gap-2">
                  {k.name} <code className="text-xs text-muted-foreground">{k.prefix}…</code>
                  {status !== 'active' && (
                    <span className={`rounded px-1.5 py-0.5 text-xs ${BADGE[status]}`}>
                      {status === 'rotating' && k.gracePeriodEnd
                        ? t('rotatingUntil', {
                            when: format.dateTime(new Date(k.gracePeriodEnd), 'short'),
                          })
                        : t(`status.${status}`)}
                    </span>
                  )}
                  {k.unused && (
                    <span className="rounded bg-amber-100 px-1.5 py-0.5 text-xs text-amber-900">
                      {t('unused')}
                    </span>
                  )}
                </div>
                <div className="text-xs text-muted-foreground">
                  {k.scopes.join(', ')} ·{' '}
                  {k.workspaces.length ? k.workspaces.join(', ') : t('allWorkspaces')}
                  {k.moduleIds.length > 0 &&
                    ` · ${k.moduleIds.map((id) => moduleName.get(id) ?? id).join(', ')}`}
                </div>
                <div className="text-xs text-muted-foreground">
                  {k.createdBy?.email
                    ? t('createdBy', {
                        who: k.createdBy.email,
                        when: format.relativeTime(new Date(k.createdAt)),
                      })
                    : t('created', { when: format.relativeTime(new Date(k.createdAt)) })}
                  {k.lastUsedAt &&
                    ` · ${t('lastUsed', { when: format.relativeTime(new Date(k.lastUsedAt)) })}`}
                  {k.expiresAt &&
                    ` · ${t('expiresOn', { when: format.dateTime(new Date(k.expiresAt), 'short') })}`}
                </div>
              </div>
              {live && (
                <div className="flex flex-wrap gap-2">
                  {/* Stays mounted while rotating, so the new secret stays on screen. */}
                  <ActionForm
                    action={rotateOrgKeyAction.bind(null, orgSlug, k.id)}
                    submitLabel={t('rotate')}
                    confirm={t('rotateConfirm', { name: k.name })}
                    secretHint={t('copyOnce')}
                    variant="outline"
                    className="flex flex-wrap items-center gap-2"
                  >
                    <select
                      name="gracePeriodHours"
                      defaultValue="24"
                      aria-label={t('grace')}
                      className="rounded-md border px-2 py-1 text-xs"
                    >
                      {[0, 1, 24, 72, 168].map((h) => (
                        <option key={h} value={h}>
                          {t('graceHours', { hours: h })}
                        </option>
                      ))}
                    </select>
                  </ActionForm>
                  <ActionForm
                    action={revokeOrgKeyAction.bind(null, orgSlug, k.id)}
                    submitLabel={t('revoke')}
                    confirm={t('revokeConfirm', { name: k.name })}
                    variant="danger"
                  />
                </div>
              )}
            </div>
          );
        })}
        {keys.length === 0 && <p className="p-4 text-sm text-muted-foreground">{t('empty')}</p>}
      </section>
    </>
  );
}
