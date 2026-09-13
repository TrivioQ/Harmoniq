import { PrismaClient } from '@harmoniq/db';
import { getTranslations } from 'next-intl/server';

const db = new PrismaClient();

export default async function WorkspaceOverview(props: {
  params: Promise<{ workspaceSlug: string }>;
}) {
  const t = await getTranslations('WorkspaceOverview');
  const params = await props.params;

  const workspace = await db.workspace.findUnique({
    where: { slug: params.workspaceSlug },
    include: {
      HostApps: {
        include: {
          RemoteModules: true,
          Environments: true
        }
      }
    }
  });

  if (!workspace) return null;

  const hostAppCount = workspace.HostApps.length;
  const moduleCount = workspace.HostApps.reduce((acc, app) => acc + app.RemoteModules.length, 0);

  return (
    <div className="container p-6 md:p-10 max-w-6xl space-y-8">
      <div>
        <h2 className="text-3xl font-bold tracking-tight">{t('title')}</h2>
        <p className="text-muted-foreground mt-2">
          {t('description', { workspaceName: workspace.name })}
        </p>
      </div>
      
      <div className="grid gap-4 md:grid-cols-3">
        <div className="rounded-xl border bg-card text-card-foreground shadow-sm p-6">
          <div className="flex flex-row items-center justify-between space-y-0 pb-2">
            <h3 className="tracking-tight text-sm font-medium">{t('hostApps')}</h3>
          </div>
          <div className="text-2xl font-bold">{hostAppCount}</div>
        </div>
        
        <div className="rounded-xl border bg-card text-card-foreground shadow-sm p-6">
          <div className="flex flex-row items-center justify-between space-y-0 pb-2">
            <h3 className="tracking-tight text-sm font-medium">{t('remoteModules')}</h3>
          </div>
          <div className="text-2xl font-bold">{moduleCount}</div>
        </div>

        <div className="rounded-xl border bg-card text-card-foreground shadow-sm p-6">
          <div className="flex flex-row items-center justify-between space-y-0 pb-2">
            <h3 className="tracking-tight text-sm font-medium">{t('healthStatus')}</h3>
          </div>
          <div className="text-2xl font-bold text-green-600">{t('healthy')}</div>
        </div>
      </div>
      
      <div className="rounded-xl border bg-card text-card-foreground shadow-sm mt-8">
        <div className="flex flex-col space-y-1.5 p-6 border-b">
          <h3 className="font-semibold leading-none tracking-tight">{t('recentActivity')}</h3>
        </div>
        <div className="p-6">
          <p className="text-sm text-muted-foreground">{t('noActivity')}</p>
        </div>
      </div>
    </div>
  );
}
