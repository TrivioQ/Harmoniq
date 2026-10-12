// Copyright The Harmoniq Authors
// SPDX-License-Identifier: Apache-2.0

import { notFound } from 'next/navigation';
import { getFormatter, getTranslations } from 'next-intl/server';
import { ActionForm } from '@/components/ActionForm';
import { Link } from '@/i18n/routing';
import { SETTING_KEYS, SETTING_PAGES, SettingKey, adminApi } from '@/lib/adminApi';
import { restoreSettingVersionAction, saveSettingJsonAction } from '../../actions';
import { SettingSource } from '../../SettingSource';

/**
 * INST-34/35: one setting. Those without a page of their own (plans, rate limits, GC,
 * bundles) are edited as JSON here; every setting shows its saved versions, what each
 * changed, and can go back to one.
 */
export default async function AdminSettingPage({ params }: { params: Promise<{ key: string }> }) {
  const { key: raw } = await params;
  if (!(SETTING_KEYS as readonly string[]).includes(raw)) notFound();
  const key = raw as SettingKey;
  const t = await getTranslations('AdminSettings');
  const format = await getFormatter();
  const [view, { versions }] = await Promise.all([
    adminApi.settings(),
    adminApi.settingHistory(key),
  ]);
  const setting = view[key] ?? { source: 'environment' as const, value: {} };
  const ownPage = SETTING_PAGES[key];

  return (
    <div className="space-y-6 max-w-3xl">
      <Link href="/admin/settings" className="text-sm text-indigo-700 hover:underline">
        ← {t('indexTitle')}
      </Link>
      <h1 className="text-2xl font-bold text-gray-900">{t(`key_${key}`)}</h1>
      <p className="text-sm text-gray-600">{t(`keyHint_${key}`)}</p>
      <SettingSource settingKey={key} source={setting.source} />
      {ownPage ? (
        <Link href={ownPage} className="text-sm text-indigo-700 hover:underline">
          {t('edit')}
        </Link>
      ) : (
        <section className="bg-white p-4 rounded-lg shadow-sm border border-gray-100">
          <ActionForm action={saveSettingJsonAction.bind(null, key)} submitLabel={t('save')}>
            <textarea
              name="value"
              rows={14}
              aria-label={t(`key_${key}`)}
              defaultValue={JSON.stringify(setting.value, null, 2)}
              className="block w-full rounded-md border px-3 py-1.5 font-mono text-xs"
            />
            <p className="text-xs text-gray-500">{t('jsonHint')}</p>
          </ActionForm>
        </section>
      )}
      <section className="space-y-2">
        <h2 className="text-lg font-semibold text-gray-900">{t('versions')}</h2>
        {versions.length === 0 ? (
          <p className="text-sm text-gray-500">{t('noVersions')}</p>
        ) : (
          <ul className="bg-white rounded-lg shadow-sm border border-gray-100 divide-y">
            {versions.map((v, i) => (
              <li key={v.version} className="p-4 text-sm">
                <details>
                  <summary className="cursor-pointer flex flex-wrap items-center gap-2">
                    <span className="font-medium">v{v.version}</span>
                    <span className="rounded bg-gray-100 px-1.5 py-0.5 text-xs text-gray-600">
                      {t(`source_${v.source}`)}
                    </span>
                    <span className="text-gray-500">
                      {format.dateTime(new Date(v.createdAt), 'short')}
                    </span>
                    {i === 0 && (
                      <span className="text-xs text-green-700">{t('currentVersion')}</span>
                    )}
                  </summary>
                  <div className="mt-3 space-y-2">
                    <p className="text-gray-700">
                      {v.changed.length
                        ? t('changedFields', { fields: v.changed.join(', ') })
                        : t('nothingChanged')}
                      {v.secretsChanged && ` ${t('secretsChanged')}`}
                    </p>
                    <pre className="overflow-auto rounded bg-gray-50 p-2 text-xs">
                      {JSON.stringify(v.value, null, 2)}
                    </pre>
                    {i > 0 && v.source !== 'reset' && (
                      <ActionForm
                        action={restoreSettingVersionAction.bind(null, key, v.version)}
                        submitLabel={t('restore', { version: v.version })}
                        variant="outline"
                        confirm={t('restoreConfirm', { version: v.version })}
                      />
                    )}
                  </div>
                </details>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
