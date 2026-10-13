// Copyright The Harmoniq Authors
// SPDX-License-Identifier: Apache-2.0

import { getFormatter, getTranslations } from 'next-intl/server';
import { ActionForm } from '@/components/ActionForm';
import type { SupportAccess } from '@/lib/adminApi';
import { Link } from '@/i18n/routing';
import { getMe } from '@/lib/registry';
import { endSupportGrantAction, openSupportGrantAction } from './actions';

/**
 * INST-20: who has read-only support access to this tenant now, and a way to open it
 * (a written reason, 1–4 hours). The tenant's admins see the same list.
 */
export async function SupportAccessPanel({
  target,
  grants,
}: {
  target: { kind: 'workspace' | 'organization'; slug: string };
  grants: SupportAccess[];
}) {
  const t = await getTranslations('AdminSupportAccess');
  const format = await getFormatter();
  // With your own grant active, open the tenant's pages (read-only).
  const me = await getMe();
  const mine = grants.some((g) => g.admin === me?.user.email);
  const view = target.kind === 'workspace' ? `/w/${target.slug}` : `/orgs/${target.slug}`;
  return (
    <section className="bg-white p-4 rounded-lg shadow-sm border border-gray-100 space-y-3">
      <h2 className="text-sm font-medium text-gray-700">{t('title')}</h2>
      <p className="text-xs text-gray-500">{t('hint')}</p>
      {mine && (
        <Link href={view} className="inline-block text-sm text-indigo-700 hover:underline">
          {t('view')} →
        </Link>
      )}
      {grants.length > 0 && (
        <ul className="divide-y text-sm">
          {grants.map((g) => (
            <li key={g.id} className="py-2 flex items-start justify-between gap-4">
              <div>
                <div className="text-gray-900">
                  {g.admin}
                  {g.scope !== target.kind && (
                    <span className="ml-2 text-xs text-gray-500">{t('viaOrganization')}</span>
                  )}
                </div>
                <div className="text-xs text-gray-600">{g.reason}</div>
                <div className="text-xs text-gray-500">
                  {t('until', { date: format.dateTime(new Date(g.expiresAt), 'short') })}
                </div>
              </div>
              <ActionForm
                action={endSupportGrantAction.bind(null, g.id)}
                submitLabel={t('end')}
                variant="outline"
              />
            </li>
          ))}
        </ul>
      )}
      <details>
        <summary className="cursor-pointer text-sm text-indigo-700">{t('open')}</summary>
        <ActionForm
          action={openSupportGrantAction.bind(null, target)}
          submitLabel={t('openSubmit')}
          className="mt-2 space-y-2"
        >
          <label className="text-sm space-y-1 block">
            <span>{t('reason')}</span>
            <textarea
              name="reason"
              required
              minLength={10}
              maxLength={500}
              rows={2}
              placeholder={t('reasonPlaceholder')}
              className="block w-full rounded-md border px-3 py-1.5 text-sm"
            />
          </label>
          <label className="text-sm flex items-center gap-2">
            <span>{t('hours')}</span>
            <select name="hours" defaultValue="1" className="rounded-md border px-2 py-1 text-sm">
              {[1, 2, 3, 4].map((h) => (
                <option key={h} value={h}>
                  {t('hoursOption', { count: h })}
                </option>
              ))}
            </select>
          </label>
        </ActionForm>
      </details>
    </section>
  );
}
