import { getTranslations } from 'next-intl/server';
import { Link } from '@/i18n/routing';
import { authedFetch } from '@/lib/registry';

type WorkspaceItem = {
  id: string;
  name: string;
  slug: string;
  _count?: { RemoteModules: number };
};

const th = 'px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider';

export default async function AdminWorkspacesPage() {
  const t = await getTranslations('AdminWorkspacesPage');
  const workspaces = await authedFetch<WorkspaceItem[]>('/api/admin/workspaces').catch(() => null);

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold text-gray-900">{t('title')}</h1>
      {!workspaces && (
        <div className="p-4 bg-red-50 text-red-700 rounded-md">{t('errorFetch')}</div>
      )}

      <div className="bg-white rounded-lg shadow-sm border border-gray-100 overflow-hidden">
        <table className="min-w-full divide-y divide-gray-200">
          <thead className="bg-gray-50">
            <tr>
              <th scope="col" className={th}>
                {t('name')}
              </th>
              <th scope="col" className={th}>
                {t('slug')}
              </th>
              <th scope="col" className={th}>
                {t('modules')}
              </th>
              <th scope="col" className={`${th} text-right`}>
                {t('actions')}
              </th>
            </tr>
          </thead>
          <tbody className="bg-white divide-y divide-gray-200">
            {(workspaces ?? []).map((ws) => (
              <tr key={ws.id}>
                <td className="px-6 py-4 whitespace-nowrap text-sm font-medium text-gray-900">
                  {ws.name}
                </td>
                <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">{ws.slug}</td>
                <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">
                  {ws._count?.RemoteModules ?? 0}
                </td>
                <td className="px-6 py-4 whitespace-nowrap text-right text-sm font-medium">
                  <Link
                    href={`/admin/workspaces/${ws.slug}`}
                    className="text-indigo-600 hover:text-indigo-900"
                  >
                    {t('manageStorage')}
                  </Link>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
