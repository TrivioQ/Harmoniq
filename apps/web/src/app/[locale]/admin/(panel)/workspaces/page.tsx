import { getFormatter, getTranslations } from 'next-intl/server';
import { Link } from '@/i18n/routing';
import { ActionForm } from '@/components/ActionForm';
import { adminApi } from '@/lib/adminApi';
import {
  deleteWorkspaceAction,
  suspendWorkspaceAction,
  unsuspendWorkspaceAction,
} from '../actions';
import { PlanForm } from '../PlanForm';

const th = 'px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider';
const td = 'px-4 py-3 text-sm text-gray-700 align-top';
const small = 'rounded-md border px-2 py-1 text-xs';

/** INST-09: every workspace, with usage; suspend, unsuspend or delete. */
export default async function AdminWorkspacesPage(props: {
  searchParams: Promise<{ query?: string; cursor?: string }>;
}) {
  const { query, cursor } = await props.searchParams;
  const t = await getTranslations('AdminWorkspacesPage');
  const format = await getFormatter();
  const { workspaces, nextCursor } = await adminApi.workspaces({ query, cursor });

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold text-gray-900">{t('title')}</h1>
      <form className="flex gap-2">
        <input
          name="query"
          defaultValue={query}
          placeholder={t('search')}
          aria-label={t('search')}
          className="rounded-md border px-3 py-1.5 text-sm w-72"
        />
        <button className="rounded-md border px-3 py-1.5 text-sm bg-white">
          {t('searchButton')}
        </button>
      </form>

      <div className="bg-white rounded-lg shadow-sm border border-gray-100 overflow-x-auto">
        <table className="min-w-full divide-y divide-gray-200">
          <thead className="bg-gray-50">
            <tr>
              <th className={th}>{t('name')}</th>
              <th className={th}>{t('usage')}</th>
              <th className={th}>{t('plan')}</th>
              <th className={th}>{t('status')}</th>
              <th className={th}>{t('actions')}</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-200">
            {workspaces.map((ws) => (
              <tr key={ws.id}>
                <td className={td}>
                  <div className="font-medium text-gray-900">{ws.name}</div>
                  <div className="text-xs text-gray-500">
                    {ws.slug}
                    {ws.organization && ` · ${t('inOrg', { org: ws.organization })}`}
                  </div>
                  <div className="text-xs text-gray-400">
                    {format.dateTime(new Date(ws.createdAt), 'short')}
                  </div>
                </td>
                <td className={td}>
                  {t('usageLine', {
                    modules: ws.modules,
                    members: ws.members,
                    deploys: ws.deploys,
                  })}
                </td>
                <td className={td}>
                  <PlanForm target={{ kind: 'workspace', slug: ws.slug }} plan={ws.plan} />
                  {ws.organizationPlan && (
                    <div className="text-xs text-gray-500 mt-1">
                      {t('orgPlan', { plan: ws.organizationPlan })}
                    </div>
                  )}
                </td>
                <td className={td}>
                  {ws.suspendedAt ? (
                    <span className="text-red-700">
                      {t('suspended')}
                      {ws.suspendedReason && (
                        <span className="block text-xs text-gray-500">{ws.suspendedReason}</span>
                      )}
                    </span>
                  ) : (
                    <span className="text-green-700">{t('active')}</span>
                  )}
                </td>
                <td className={`${td} space-y-2`}>
                  {ws.suspendedAt ? (
                    <ActionForm
                      action={unsuspendWorkspaceAction.bind(null, ws.slug)}
                      submitLabel={t('unsuspend')}
                      variant="outline"
                    />
                  ) : (
                    <ActionForm
                      action={suspendWorkspaceAction.bind(null, ws.slug)}
                      submitLabel={t('suspend')}
                      variant="outline"
                      confirm={t('suspendConfirm', { slug: ws.slug })}
                      className="flex gap-2 items-start"
                    >
                      <input name="reason" placeholder={t('reason')} className={small} />
                    </ActionForm>
                  )}
                  <ActionForm
                    action={deleteWorkspaceAction.bind(null, ws.slug)}
                    submitLabel={t('delete')}
                    variant="danger"
                    confirm={t('deleteConfirm', { slug: ws.slug })}
                    className="flex gap-2 items-start"
                  >
                    <input
                      name="confirm"
                      required
                      placeholder={ws.slug}
                      aria-label={t('typeSlug')}
                      className={small}
                    />
                  </ActionForm>
                  <Link
                    href={`/admin/workspaces/${ws.slug}`}
                    className="block text-xs text-indigo-600 hover:text-indigo-900"
                  >
                    {t('manageStorage')}
                  </Link>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {nextCursor && (
        <Link
          href={`/admin/workspaces?${new URLSearchParams({ ...(query && { query }), cursor: nextCursor })}`}
          className="text-sm text-indigo-600"
        >
          {t('next')}
        </Link>
      )}
    </div>
  );
}
