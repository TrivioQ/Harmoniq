import { getTranslations } from 'next-intl/server';
import { adminApi } from '@/lib/adminApi';
import { PlanForm } from '../PlanForm';

const th = 'px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider';
const td = 'px-4 py-3 text-sm text-gray-700 align-top';

/** PLN-01: organizations and their plans (a workspace gets its organization's when higher). */
export default async function AdminOrgsPage() {
  const t = await getTranslations('AdminOrgsPage');
  const { organizations } = await adminApi.orgs();

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold text-gray-900">{t('title')}</h1>
      <p className="text-sm text-gray-600">{t('description')}</p>
      {organizations.length === 0 ? (
        <p className="text-sm text-gray-500">{t('empty')}</p>
      ) : (
        <div className="bg-white rounded-lg shadow-sm border border-gray-100 overflow-x-auto">
          <table className="min-w-full divide-y divide-gray-200">
            <thead className="bg-gray-50">
              <tr>
                <th className={th}>{t('name')}</th>
                <th className={th}>{t('size')}</th>
                <th className={th}>{t('plan')}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-200">
              {organizations.map((o) => (
                <tr key={o.slug}>
                  <td className={td}>
                    <div className="font-medium text-gray-900">{o.name}</div>
                    <div className="text-xs text-gray-500">{o.slug}</div>
                  </td>
                  <td className={td}>
                    {t('sizeLine', { workspaces: o.workspaces, members: o.members })}
                  </td>
                  <td className={td}>
                    <PlanForm target={{ kind: 'org', slug: o.slug }} plan={o.plan} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
