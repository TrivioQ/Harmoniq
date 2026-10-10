import { getFormatter, getTranslations } from 'next-intl/server';
import { Link } from '@/i18n/routing';
import { workspaceApi } from '@/lib/workspaceApi';
import { AuditLine } from './AuditLine';

export default async function WorkspaceOverview(props: {
  params: Promise<{ workspaceSlug: string }>;
}) {
  const { workspaceSlug } = await props.params;
  const t = await getTranslations('WorkspaceOverview');
  const format = await getFormatter();
  const [workspace, audit] = await Promise.all([
    workspaceApi.get(workspaceSlug),
    workspaceApi.audit(workspaceSlug, { limit: '10' }),
  ]);

  const environments = workspace.hostApps.flatMap((h) => h.environments);
  const frozen = environments.filter((e) => e.frozen).length;
  const stats = [
    [t('hostApps'), workspace.hostApps.length],
    [t('remoteModules'), workspace.hostApps.reduce((n, h) => n + h.moduleCount, 0)],
    [t('environments'), environments.length],
    [t('frozenEnvironments'), frozen],
  ] as const;

  return (
    <div className="container p-6 md:p-10 max-w-6xl space-y-8">
      <div>
        <h2 className="text-3xl font-bold tracking-tight">{t('title')}</h2>
        <p className="text-muted-foreground mt-2">
          {t('description', { workspaceName: workspace.name })}
        </p>
      </div>

      <div className="grid gap-4 md:grid-cols-4">
        {stats.map(([label, value]) => (
          <div key={label} className="rounded-xl border bg-card text-card-foreground shadow-sm p-6">
            <h3 className="tracking-tight text-sm font-medium text-muted-foreground">{label}</h3>
            <div className="text-2xl font-bold mt-1">{value}</div>
          </div>
        ))}
      </div>

      <div className="rounded-xl border bg-card text-card-foreground shadow-sm">
        <div className="flex items-center justify-between p-6 border-b">
          <h3 className="font-semibold leading-none tracking-tight">{t('recentActivity')}</h3>
          <Link href={`/w/${workspaceSlug}/audit`} className="text-sm text-primary hover:underline">
            {t('viewAll')}
          </Link>
        </div>
        <ul className="divide-y">
          {audit.events.map((event) => (
            <li key={event.id} className="px-6 py-3 flex justify-between gap-4 text-sm">
              <AuditLine event={event} />
              <time className="text-muted-foreground whitespace-nowrap" dateTime={event.createdAt}>
                {format.relativeTime(new Date(event.createdAt))}
              </time>
            </li>
          ))}
          {audit.events.length === 0 && (
            <li className="p-6 text-sm text-muted-foreground">{t('noActivity')}</li>
          )}
        </ul>
      </div>
    </div>
  );
}
