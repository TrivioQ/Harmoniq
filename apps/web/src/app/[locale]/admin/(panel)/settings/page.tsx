// Copyright The Harmoniq Authors
// SPDX-License-Identifier: Apache-2.0

import { getTranslations } from 'next-intl/server';
import { ActionForm } from '@/components/ActionForm';
import { Link } from '@/i18n/routing';
import { SETTING_KEYS, SETTING_PAGES, adminApi } from '@/lib/adminApi';
import { importSettingsAction } from '../actions';

/** A file download (YAML), not a page. */
const EXPORT_URL = '/api/settings-export';

/** INST-34/35: every instance setting, where it comes from, export and import. */
export default async function AdminSettingsIndexPage() {
  const t = await getTranslations('AdminSettings');
  const view = await adminApi.settings();

  return (
    <div className="space-y-6 max-w-3xl">
      <h1 className="text-2xl font-bold text-gray-900">{t('indexTitle')}</h1>
      <p className="text-sm text-gray-600">{t('indexDescription')}</p>
      <ul className="bg-white rounded-lg shadow-sm border border-gray-100 divide-y">
        {SETTING_KEYS.map((key) => {
          const source = view[key]?.source ?? 'environment';
          return (
            <li key={key} className="p-4 flex items-center justify-between gap-4 text-sm">
              <div>
                <div className="font-medium text-gray-900">{t(`key_${key}`)}</div>
                <code className="text-xs text-gray-500">{key}</code>
              </div>
              <div className="flex items-center gap-4">
                <span
                  className={`rounded px-1.5 py-0.5 text-xs ${source === 'database' ? 'bg-indigo-50 text-indigo-700' : 'bg-gray-100 text-gray-600'}`}
                >
                  {source === 'database' ? t('badgeDatabase') : t('badgeEnvironment')}
                </span>
                <Link
                  href={SETTING_PAGES[key] ?? `/admin/settings/${key}`}
                  className="text-indigo-700 hover:underline"
                >
                  {t('edit')}
                </Link>
                <Link href={`/admin/settings/${key}`} className="text-indigo-700 hover:underline">
                  {t('history')}
                </Link>
              </div>
            </li>
          );
        })}
      </ul>
      <section className="bg-white p-4 rounded-lg shadow-sm border border-gray-100 space-y-3">
        <h2 className="text-lg font-semibold text-gray-900">{t('exportTitle')}</h2>
        <p className="text-sm text-gray-600">{t('exportDescription')}</p>
        <a
          href={EXPORT_URL}
          download
          className="inline-flex items-center rounded-md border px-3 py-1.5 text-sm font-medium hover:bg-muted"
        >
          {t('export')}
        </a>
      </section>
      <section className="bg-white p-4 rounded-lg shadow-sm border border-gray-100">
        <h2 className="text-lg font-semibold text-gray-900 mb-2">{t('importTitle')}</h2>
        <ActionForm action={importSettingsAction} submitLabel={t('import')}>
          <textarea
            name="yaml"
            required
            rows={8}
            aria-label={t('importTitle')}
            placeholder={'harmoniq: instance-settings/v1\nsettings:\n  branding:\n    name: Acme'}
            className="block w-full rounded-md border px-3 py-1.5 font-mono text-xs"
          />
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" name="apply" />
            {t('importApply')}
          </label>
        </ActionForm>
      </section>
    </div>
  );
}
