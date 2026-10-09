import { notFound } from 'next/navigation';
import { getFormatter, getTranslations } from 'next-intl/server';
import { Link } from '@/i18n/routing';
import { ActionForm } from '@/components/ActionForm';
import { RegistryError } from '@/lib/registry';
import { roleAtLeast, workspaceApi } from '@/lib/workspaceApi';
import { promoteAction, rollbackAction } from '../../actions';

const statusStyle: Record<string, string> = {
  active: 'bg-green-100 text-green-800',
  canary: 'bg-amber-100 text-amber-800',
  inactive: 'bg-muted text-muted-foreground',
};

export default async function ModuleDetailPage(props: {
  params: Promise<{ workspaceSlug: string; moduleRef: string }>;
  searchParams: Promise<{ env?: string }>;
}) {
  const { workspaceSlug, moduleRef } = await props.params;
  const { env: envParam } = await props.searchParams;
  const t = await getTranslations('ModuleDetail');
  const format = await getFormatter();

  const [module, workspace] = await Promise.all([
    workspaceApi.module(workspaceSlug, moduleRef).catch((err) => {
      if (err instanceof RegistryError && err.status === 404) notFound();
      throw err;
    }),
    workspaceApi.get(workspaceSlug),
  ]);
  const env = module.environments.find((e) => e.slug === envParam) ?? module.environments[0];
  if (!env) notFound();
  const { versions } = await workspaceApi.versions(workspaceSlug, module.id, env.slug);
  const active = versions.find((v) => v.status === 'active');

  const canDeploy = roleAtLeast(workspace.role, 'developer');
  // PRO-05: promotion is offered to admins and owners.
  const canPromote = roleAtLeast(workspace.role, 'admin') && !!active;
  const promoteTargets = module.environments.filter((e) => e.slug !== env.slug);

  return (
    <div className="container p-6 md:p-10 max-w-6xl space-y-6">
      <div>
        <Link
          href={`/${workspaceSlug}/modules`}
          className="text-sm text-muted-foreground hover:underline"
        >
          ← {t('back')}
        </Link>
        <h2 className="text-3xl font-bold tracking-tight mt-2">{module.name}</h2>
        <p className="text-muted-foreground">
          {module.slug} · {module.hostApp.name}
        </p>
      </div>

      <nav className="flex gap-2 border-b" aria-label={t('environments')}>
        {module.environments.map((e) => (
          <Link
            key={e.slug}
            href={`/${workspaceSlug}/modules/${module.id}?env=${e.slug}`}
            className={`px-3 py-2 text-sm border-b-2 -mb-px ${e.slug === env.slug ? 'border-primary font-medium' : 'border-transparent text-muted-foreground'}`}
          >
            {e.name} {e.frozen && '🔒'}
          </Link>
        ))}
      </nav>

      {env.frozen && (
        <div className="rounded-md bg-blue-50 border border-blue-200 p-3 text-sm text-blue-900">
          🔒 {t('frozen', { reason: env.freezeReason ?? '' })}
        </div>
      )}

      {canPromote && promoteTargets.length > 0 && (
        <section className="rounded-xl border bg-card p-4">
          <ActionForm
            action={promoteAction.bind(null, workspaceSlug, module.id, env.slug)}
            submitLabel={t('promote', { version: active!.version })}
            confirm={t('promoteConfirm', { version: active!.version })}
            className="flex flex-wrap items-center gap-3"
          >
            <label className="text-sm" htmlFor="toEnvironment">
              {t('promoteTo')}
            </label>
            <select
              id="toEnvironment"
              name="toEnvironment"
              className="rounded-md border px-2 py-1.5 text-sm"
            >
              {promoteTargets.map((e) => (
                <option key={e.slug} value={e.slug}>
                  {e.name}
                </option>
              ))}
            </select>
          </ActionForm>
        </section>
      )}

      <div className="rounded-xl border bg-card overflow-hidden">
        <table className="min-w-full text-sm">
          <thead className="bg-muted/50 text-left">
            <tr>
              <th className="px-4 py-2 font-medium">{t('version')}</th>
              <th className="px-4 py-2 font-medium">{t('status')}</th>
              <th className="px-4 py-2 font-medium">{t('deployed')}</th>
              <th className="px-4 py-2 font-medium">{t('source')}</th>
              <th className="px-4 py-2" />
            </tr>
          </thead>
          <tbody className="divide-y">
            {versions.map((v) => (
              <tr key={v.id}>
                <td className="px-4 py-2">
                  <div className="font-mono">{v.version}</div>
                  <div className="text-xs text-muted-foreground truncate max-w-xs" title={v.url}>
                    {v.url}
                  </div>
                </td>
                <td className="px-4 py-2">
                  <span className={`rounded px-2 py-0.5 text-xs ${statusStyle[v.status] ?? ''}`}>
                    {t(`statuses.${v.status}`)}
                  </span>
                </td>
                <td className="px-4 py-2 whitespace-nowrap">
                  <time dateTime={v.deployedAt}>{format.relativeTime(new Date(v.deployedAt))}</time>
                  <div className="text-xs text-muted-foreground">
                    {v.deployedByType === 'apiKey' ? t('byApiKey') : t('byUser')}
                  </div>
                </td>
                <td className="px-4 py-2 text-xs text-muted-foreground">
                  {v.promotedFromEnv && t('promotedFrom', { environment: v.promotedFromEnv })}
                  {v.commitSha && <div className="font-mono">{v.commitSha.slice(0, 7)}</div>}
                </td>
                <td className="px-4 py-2 text-right">
                  {canDeploy && v.status === 'inactive' && !env.frozen && (
                    <ActionForm
                      action={rollbackAction.bind(null, workspaceSlug, module.id, env.slug, v.id)}
                      submitLabel={t('rollback')}
                      pendingLabel={t('rollingBack')}
                      confirm={t('rollbackConfirm', { version: v.version, environment: env.name })}
                      variant="outline"
                      className="inline-flex flex-col items-end gap-1"
                    />
                  )}
                </td>
              </tr>
            ))}
            {versions.length === 0 && (
              <tr>
                <td colSpan={5} className="px-4 py-6 text-center text-muted-foreground">
                  {t('noVersions')}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
