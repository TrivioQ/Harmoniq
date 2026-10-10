import { getFormatter, getTranslations } from 'next-intl/server';
import { Link } from '@/i18n/routing';
import { ActionForm } from '@/components/ActionForm';
import { orgApi } from '@/lib/orgApi';
import { attachWorkspaceAction, createOrgWorkspaceAction, detachWorkspaceAction } from '../actions';

const input = 'rounded-md border px-3 py-1.5 text-sm';

/** ORG-14: the organization home. */
export default async function OrgHomePage(props: { params: Promise<{ orgSlug: string }> }) {
  const { orgSlug } = await props.params;
  const t = await getTranslations('OrgHome');
  const format = await getFormatter();
  const org = await orgApi.home(orgSlug);
  const admin = org.role === 'org_admin';

  return (
    <>
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">{org.name}</h1>
        <p className="text-sm text-muted-foreground">{t('description')}</p>
      </div>

      <section className="rounded-xl border bg-card">
        <table className="w-full text-sm">
          <thead className="text-left text-muted-foreground">
            <tr>
              <th className="p-3 font-medium">{t('workspace')}</th>
              <th className="p-3 font-medium">{t('modules')}</th>
              <th className="p-3 font-medium">{t('members')}</th>
              <th className="p-3 font-medium">{t('lastDeploy')}</th>
              <th className="p-3 font-medium">{t('health')}</th>
              {admin && <th className="p-3" />}
            </tr>
          </thead>
          <tbody>
            {org.workspaces.map((w) => (
              <tr key={w.slug} className="border-t">
                <td className="p-3">
                  <Link href={`/w/${w.slug}`} className="font-medium hover:text-primary">
                    {w.name}
                  </Link>
                  <div className="text-xs text-muted-foreground font-mono">{w.slug}</div>
                </td>
                <td className="p-3">{w.modules}</td>
                <td className="p-3">{w.members}</td>
                <td className="p-3">
                  {w.lastDeployAt ? format.relativeTime(new Date(w.lastDeployAt)) : '—'}
                </td>
                <td className="p-3">
                  {w.health
                    ? t('errorRate', {
                        rate: format.number(w.health.errorRate, {
                          style: 'percent',
                          maximumFractionDigits: 2,
                        }),
                        samples: w.health.samples,
                      })
                    : '—'}
                </td>
                {admin && (
                  <td className="p-3 text-right">
                    <ActionForm
                      action={detachWorkspaceAction.bind(null, org.slug, w.slug)}
                      submitLabel={t('detach')}
                      confirm={t('detachConfirm', { workspace: w.name })}
                      variant="outline"
                    />
                  </td>
                )}
              </tr>
            ))}
            {org.workspaces.length === 0 && (
              <tr>
                <td colSpan={6} className="p-6 text-center text-muted-foreground">
                  {t('noWorkspaces')}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </section>

      {admin && (
        <div className="grid gap-4 md:grid-cols-2">
          <section className="rounded-xl border bg-card p-4 space-y-2">
            <h2 className="font-semibold text-sm">{t('createWorkspace')}</h2>
            <ActionForm
              action={createOrgWorkspaceAction.bind(null, org.slug)}
              submitLabel={t('create')}
              className="flex flex-wrap gap-2"
            >
              <input
                name="name"
                required
                placeholder="Checkout team"
                aria-label={t('name')}
                className={input}
              />
              <input
                name="slug"
                required
                pattern="[a-z0-9]([a-z0-9-]*[a-z0-9])?"
                placeholder="checkout"
                aria-label={t('slug')}
                className={`${input} font-mono`}
              />
            </ActionForm>
          </section>
          <section className="rounded-xl border bg-card p-4 space-y-2">
            <h2 className="font-semibold text-sm">{t('attach')}</h2>
            <p className="text-xs text-muted-foreground">{t('attachHint')}</p>
            <ActionForm
              action={attachWorkspaceAction.bind(null, org.slug)}
              submitLabel={t('attachSubmit')}
              className="flex flex-wrap gap-2"
            >
              <input
                name="workspace"
                required
                placeholder="design-system"
                aria-label={t('slug')}
                className={`${input} font-mono`}
              />
            </ActionForm>
          </section>
        </div>
      )}

      <section className="rounded-xl border bg-card p-4 space-y-2">
        <h2 className="font-semibold text-sm">{t('recentDeploys')}</h2>
        {org.recentDeploys.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t('noDeploys')}</p>
        ) : (
          <ul className="text-sm divide-y">
            {org.recentDeploys.map((d, i) => (
              <li key={i} className="py-1.5 flex flex-wrap gap-x-2">
                <span className="font-mono">
                  {d.workspace}/{d.module}@{d.version}
                </span>
                <span className="text-muted-foreground">
                  {d.environment} · {d.status} · {format.relativeTime(new Date(d.deployedAt))}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </>
  );
}
