import { redirect } from 'next/navigation';
import { Link } from '@/i18n/routing';
import { ActionForm } from '@/components/ActionForm';
import { createWorkspaceAction } from './[workspaceSlug]/actions';
import { getTranslations } from 'next-intl/server';
import { getMe } from '@/lib/registry';

export default async function WorkspaceSelector() {
  const t = await getTranslations('WorkspaceSelector');
  const me = await getMe();
  if (!me) redirect('/auth/login');
  const { workspaces } = me;

  return (
    <div className="flex flex-col min-h-screen items-center p-6 md:p-24 bg-muted/30">
      <div className="w-full max-w-2xl space-y-8">
        <div>
          <h1 className="text-3xl font-semibold tracking-tight">{t('title')}</h1>
          <p className="text-muted-foreground mt-2">{t('description')}</p>
        </div>

        <div className="grid gap-4">
          {workspaces.map((ws) => (
            <Link key={ws.slug} href={`/${ws.slug}`}>
              <div className="p-6 border rounded-xl bg-card hover:border-primary transition-colors cursor-pointer shadow-sm">
                <h3 className="font-medium text-lg">{ws.name}</h3>
                <p className="text-sm text-muted-foreground">{ws.slug}</p>
              </div>
            </Link>
          ))}
          {workspaces.length === 0 && (
            <div className="p-8 border border-dashed rounded-xl text-center">
              <p className="text-muted-foreground">{t('noWorkspaces')}</p>
            </div>
          )}
        </div>

        <div className="rounded-xl border bg-card p-6 space-y-3">
          <h2 className="font-semibold">{t('createWorkspace')}</h2>
          <ActionForm
            action={createWorkspaceAction}
            submitLabel={t('create')}
            className="flex flex-wrap items-center gap-2"
          >
            <input
              name="name"
              required
              placeholder="Acme Corp"
              aria-label={t('name')}
              className="rounded-md border px-3 py-1.5 text-sm"
            />
            <input
              name="slug"
              required
              pattern="[a-z0-9]([a-z0-9-]*[a-z0-9])?"
              placeholder="acme-corp"
              aria-label={t('slug')}
              className="rounded-md border px-3 py-1.5 text-sm font-mono"
            />
          </ActionForm>
        </div>
      </div>
    </div>
  );
}
