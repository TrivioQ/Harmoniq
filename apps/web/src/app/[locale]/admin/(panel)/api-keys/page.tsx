// Copyright The Harmoniq Authors
// SPDX-License-Identifier: Apache-2.0

import { getFormatter, getTranslations } from 'next-intl/server';
import { ActionForm } from '@/components/ActionForm';
import { adminApi } from '@/lib/adminApi';
import { createInstanceKeyAction, revokeInstanceKeyAction } from '../actions';

/** INST-33: keys for automation (Terraform, scripts) on the admin API only. */
export default async function AdminApiKeysPage() {
  const t = await getTranslations('AdminApiKeysPage');
  const format = await getFormatter();
  const { keys } = await adminApi.apiKeys();
  const date = (d: string | null) => (d ? format.dateTime(new Date(d), 'short') : t('never'));

  return (
    <div className="space-y-6 max-w-3xl">
      <h1 className="text-2xl font-bold text-gray-900">{t('title')}</h1>
      <p className="text-sm text-gray-600">{t('description')}</p>
      <section className="bg-white p-4 rounded-lg shadow-sm border border-gray-100">
        <ActionForm
          action={createInstanceKeyAction}
          submitLabel={t('create')}
          secretHint={t('secretHint')}
          className="flex flex-wrap items-end gap-2"
        >
          <label className="text-sm space-y-1">
            <span className="block">{t('name')}</span>
            <input
              name="name"
              required
              maxLength={100}
              placeholder="terraform"
              className="rounded-md border px-3 py-1.5 text-sm w-48"
            />
          </label>
          <label className="text-sm space-y-1">
            <span className="block">{t('scope')}</span>
            <select name="scope" className="rounded-md border px-2 py-1.5 text-sm">
              <option value="instance:read">{t('scopeRead')}</option>
              <option value="instance:admin">{t('scopeAdmin')}</option>
            </select>
          </label>
          <label className="text-sm space-y-1">
            <span className="block">{t('expires')}</span>
            <input name="expiresAt" type="date" className="rounded-md border px-3 py-1.5 text-sm" />
          </label>
        </ActionForm>
      </section>
      {keys.length === 0 ? (
        <p className="text-sm text-gray-500">{t('none')}</p>
      ) : (
        <ul className="bg-white rounded-lg shadow-sm border border-gray-100 divide-y">
          {keys.map((k) => (
            <li key={k.id} className="p-4 flex items-center justify-between gap-4">
              <div className={k.revokedAt ? 'opacity-60' : ''}>
                <div className="text-sm font-medium text-gray-900">
                  {k.name} <code className="text-xs text-gray-500">{k.prefix}…</code>
                </div>
                <div className="text-xs text-gray-500">
                  {k.scopes.join(', ')} · {t('lastUsed', { date: date(k.lastUsedAt) })} ·{' '}
                  {k.revokedAt
                    ? t('revokedOn', { date: date(k.revokedAt) })
                    : t('expiresOn', { date: date(k.expiresAt) })}
                </div>
              </div>
              {!k.revokedAt && (
                <ActionForm
                  action={revokeInstanceKeyAction.bind(null, k.id)}
                  submitLabel={t('revoke')}
                  variant="outline"
                  confirm={t('revokeConfirm', { name: k.name })}
                />
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
