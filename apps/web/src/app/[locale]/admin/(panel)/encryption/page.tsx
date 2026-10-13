// Copyright The Harmoniq Authors
// SPDX-License-Identifier: Apache-2.0

import { getTranslations } from 'next-intl/server';
import { ActionForm } from '@/components/ActionForm';
import { adminApi } from '@/lib/adminApi';
import { resealAction } from '../actions';

/** INST-26: the keyring and how many sealed values each key holds. */
export default async function AdminEncryptionPage() {
  const t = await getTranslations('AdminEncryptionPage');
  const report = await adminApi.encryption();

  return (
    <div className="space-y-6 max-w-3xl">
      <h1 className="text-2xl font-bold text-gray-900">{t('title')}</h1>
      <p className="text-sm text-gray-600">{t('description')}</p>
      <table className="w-full bg-white rounded-lg shadow-sm border border-gray-100 text-sm">
        <thead className="text-left text-gray-500">
          <tr>
            <th className="p-3 font-medium">{t('key')}</th>
            <th className="p-3 font-medium">{t('label')}</th>
            <th className="p-3 font-medium text-right">{t('values')}</th>
          </tr>
        </thead>
        <tbody className="divide-y">
          {report.keys.map((k) => (
            <tr key={k.id}>
              <td className="p-3 font-mono">
                {k.id}{' '}
                {k.active && (
                  <span className="ml-1 rounded bg-green-50 px-1.5 py-0.5 text-xs text-green-700 font-sans">
                    {t('active')}
                  </span>
                )}
              </td>
              <td className="p-3">{k.label}</td>
              <td className="p-3 text-right tabular-nums">{k.values}</td>
            </tr>
          ))}
          {report.legacy > 0 && (
            <tr>
              <td className="p-3 text-gray-500" colSpan={2}>
                {t('legacy')}
              </td>
              <td className="p-3 text-right tabular-nums">{report.legacy}</td>
            </tr>
          )}
        </tbody>
      </table>
      {report.unknownKeys.length > 0 && (
        <p
          role="alert"
          className="rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-800"
        >
          {t('unknownKeys', {
            keys: report.unknownKeys.map((k) => `${k.id} (${k.values})`).join(', '),
          })}
        </p>
      )}
      <section className="bg-white p-4 rounded-lg shadow-sm border border-gray-100 space-y-2">
        <p className="text-sm text-gray-700">
          {report.stale > 0 ? t('stale', { count: report.stale }) : t('allActive')}
        </p>
        <ActionForm action={resealAction} submitLabel={t('reseal')} variant="outline" />
        <p className="text-xs text-gray-500">{t('rotationHint')}</p>
      </section>
    </div>
  );
}
