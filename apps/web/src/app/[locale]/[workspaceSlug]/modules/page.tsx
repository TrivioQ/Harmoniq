import { PrismaClient } from '@harmoniq/db';
import { getTranslations } from 'next-intl/server';

const db = new PrismaClient();

export default async function ModulesPage(props: { params: Promise<{ workspaceSlug: string }> }) {
  const t = await getTranslations('ModulesPage');
  const params = await props.params;
  const workspace = await db.workspace.findUnique({
    where: { slug: params.workspaceSlug },
    include: {
      RemoteModules: {
        include: {
          hostApp: true,
        },
      },
    },
  });

  if (!workspace) return null;

  return (
    <div className="container p-6 md:p-10 max-w-6xl space-y-8">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-3xl font-bold tracking-tight">{t('title')}</h2>
          <p className="text-muted-foreground mt-2">{t('description')}</p>
        </div>
      </div>

      <div className="grid gap-4">
        {workspace.RemoteModules.map((module) => (
          <div
            key={module.id}
            className="rounded-xl border bg-card text-card-foreground shadow-sm p-6 flex justify-between items-center"
          >
            <div>
              <h3 className="font-semibold">{module.name}</h3>
              <p className="text-sm text-muted-foreground">
                {module.slug} &middot; {t('hostedOn', { hostAppName: module.hostApp.name })}
              </p>
            </div>
            <div className="text-sm text-muted-foreground">
              {new Date(module.createdAt).toLocaleDateString()}
            </div>
          </div>
        ))}
        {workspace.RemoteModules.length === 0 && (
          <div className="p-8 border border-dashed rounded-xl text-center">
            <p className="text-muted-foreground">{t('noModules')}</p>
          </div>
        )}
      </div>
    </div>
  );
}
