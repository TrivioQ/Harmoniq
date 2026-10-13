// Copyright The Harmoniq Authors
// SPDX-License-Identifier: Apache-2.0

import { getTranslations } from 'next-intl/server';
import { ActionForm } from '@/components/ActionForm';
import { adminApi } from '@/lib/adminApi';
import { resetSettingAction, saveAnnouncementAction, saveMaintenanceAction } from '../actions';

const input = 'block w-full rounded-md border px-3 py-1.5 text-sm';
/** An ISO time as a `datetime-local` value in UTC. */
const local = (iso?: string) => (iso ? iso.slice(0, 16) : undefined);

/** INST-22, INST-37: a banner on every page, and read-only maintenance windows. */
export default async function AdminAnnouncementsPage() {
  const t = await getTranslations('AdminAnnouncementsPage');
  const view = await adminApi.settings();
  const a = view.announcement?.source === 'database' ? view.announcement.value : {};
  const m = view.maintenance?.source === 'database' ? view.maintenance.value : null;

  return (
    <div className="space-y-6 max-w-3xl">
      <h1 className="text-2xl font-bold text-gray-900">{t('title')}</h1>

      <section className="bg-white p-4 rounded-lg shadow-sm border border-gray-100 space-y-3">
        <h2 className="text-lg font-semibold text-gray-900">{t('announcement')}</h2>
        <p className="text-sm text-gray-600">{t('announcementHint')}</p>
        <ActionForm action={saveAnnouncementAction} submitLabel={t('publish')}>
          <label className="text-sm space-y-1 block">
            <span>{t('message')}</span>
            <textarea
              name="message"
              required
              maxLength={500}
              rows={2}
              defaultValue={a.message}
              className={input}
            />
          </label>
          <div className="grid gap-3 sm:grid-cols-3">
            <label className="text-sm space-y-1 block">
              <span>{t('level')}</span>
              <select name="level" defaultValue={a.level ?? 'info'} className={input}>
                {(['info', 'warning', 'maintenance'] as const).map((l) => (
                  <option key={l} value={l}>
                    {t(`level_${l}`)}
                  </option>
                ))}
              </select>
            </label>
            <label className="text-sm space-y-1 block">
              <span>{t('startsAt')}</span>
              <input
                name="startsAt"
                type="datetime-local"
                defaultValue={local(a.startsAt)}
                className={input}
              />
            </label>
            <label className="text-sm space-y-1 block">
              <span>{t('endsAt')}</span>
              <input
                name="endsAt"
                type="datetime-local"
                defaultValue={local(a.endsAt)}
                className={input}
              />
            </label>
          </div>
          <p className="text-xs text-gray-500">{t('utcHint')}</p>
        </ActionForm>
        {view.announcement?.source === 'database' && (
          <ActionForm
            action={resetSettingAction.bind(null, 'announcement')}
            submitLabel={t('remove')}
            variant="outline"
          />
        )}
      </section>

      <section className="bg-white p-4 rounded-lg shadow-sm border border-gray-100 space-y-3">
        <h2 className="text-lg font-semibold text-gray-900">{t('maintenance')}</h2>
        <p className="text-sm text-gray-600">{t('maintenanceHint')}</p>
        {m && (
          <p role="status" className="rounded-md bg-amber-50 p-2 text-sm text-amber-900">
            {m.from && new Date(m.from) > new Date() ? t('scheduled') : t('running')}
          </p>
        )}
        <ActionForm
          action={saveMaintenanceAction}
          submitLabel={t('saveMaintenance')}
          confirm={t('maintenanceConfirm')}
        >
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="text-sm space-y-1 block">
              <span>{t('from')}</span>
              <input
                name="from"
                type="datetime-local"
                defaultValue={local(m?.from)}
                className={input}
              />
            </label>
            <label className="text-sm space-y-1 block">
              <span>{t('until')}</span>
              <input
                name="until"
                type="datetime-local"
                defaultValue={local(m?.until)}
                className={input}
              />
            </label>
          </div>
          <label className="text-sm space-y-1 block">
            <span>{t('maintenanceMessage')}</span>
            <input name="message" maxLength={500} defaultValue={m?.message} className={input} />
          </label>
          <p className="text-xs text-gray-500">{t('maintenanceFormHint')}</p>
        </ActionForm>
        {m && (
          <ActionForm
            action={resetSettingAction.bind(null, 'maintenance')}
            submitLabel={t('endMaintenance')}
            variant="outline"
          />
        )}
      </section>
    </div>
  );
}
