import { getFormatter, getTranslations } from 'next-intl/server';
import { ActionForm } from '@/components/ActionForm';
import { adminApi } from '@/lib/adminApi';
import { grantAdminAction, revokeAdminAction } from '../actions';

/** INST-05/07: who administers the instance. */
export default async function AdminAdminsPage() {
  const t = await getTranslations('AdminAdminsPage');
  const format = await getFormatter();
  const { admins } = await adminApi.admins();

  return (
    <div className="space-y-6 max-w-3xl">
      <h1 className="text-2xl font-bold text-gray-900">{t('title')}</h1>
      <p className="text-sm text-gray-600">{t('description')}</p>
      <section className="bg-white p-4 rounded-lg shadow-sm border border-gray-100">
        <ActionForm action={grantAdminAction} submitLabel={t('grant')} className="flex gap-2">
          <input
            name="email"
            type="email"
            required
            placeholder="ops@example.com"
            aria-label={t('email')}
            className="rounded-md border px-3 py-1.5 text-sm w-72"
          />
        </ActionForm>
      </section>
      <ul className="bg-white rounded-lg shadow-sm border border-gray-100 divide-y">
        {admins.map((a) => (
          <li key={a.id} className="p-4 flex items-center justify-between gap-4">
            <div>
              <div className="text-sm font-medium text-gray-900">{a.email}</div>
              <div className="text-xs text-gray-500">
                {t('since', { date: format.dateTime(new Date(a.since), 'short') })}
              </div>
            </div>
            <ActionForm
              action={revokeAdminAction.bind(null, a.id)}
              submitLabel={t('revoke')}
              variant="outline"
              confirm={t('revokeConfirm', { email: a.email })}
            />
          </li>
        ))}
      </ul>
    </div>
  );
}
