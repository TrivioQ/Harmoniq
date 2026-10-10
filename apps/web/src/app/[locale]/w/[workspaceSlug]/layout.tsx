import { notFound, redirect } from 'next/navigation';
import { Link } from '@/i18n/routing';
import { BrandMark } from '@/components/BrandMark';
import { getTranslations } from 'next-intl/server';
import { getMe } from '@/lib/registry';
import { workspaceApi } from '@/lib/workspaceApi';

export default async function WorkspaceLayout(props: {
  children: React.ReactNode;
  params: Promise<{ workspaceSlug: string }>;
}) {
  const t = await getTranslations('WorkspaceLayout');
  const params = await props.params;
  const me = await getMe();
  if (!me) redirect('/auth/login');

  // Membership comes from the registry; non-members get a 404 (no slug probing). Org
  // admins reach their organization's workspaces without a membership (ORG-08).
  const workspace =
    me.workspaces.find((w) => w.slug === params.workspaceSlug) ??
    (await workspaceApi.get(params.workspaceSlug).catch(() => null));
  if (!workspace) notFound();
  // INST-09: from /api/me (`suspended`) or the workspace itself (`suspendedAt`).
  const suspended =
    ('suspended' in workspace && !!workspace.suspended) ||
    ('suspendedAt' in workspace && !!workspace.suspendedAt);

  return (
    <div className="min-h-screen flex flex-col">
      <header className="sticky top-0 z-50 w-full border-b bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60">
        <div className="container flex h-14 items-center px-4 md:px-8">
          <div className="flex flex-1 items-center gap-4">
            <BrandMark />
            <span className="text-muted-foreground text-sm">/</span>
            <span className="font-medium text-sm">{workspace.name}</span>
          </div>
          <nav className="flex items-center gap-6 text-sm font-medium">
            <Link href={`/w/${workspace.slug}`} className="hover:text-primary">
              {t('overview')}
            </Link>
            <Link href={`/w/${workspace.slug}/modules`} className="hover:text-primary">
              {t('modules')}
            </Link>
            <Link href={`/w/${workspace.slug}/environments`} className="hover:text-primary">
              {t('environments')}
            </Link>
            <Link href={`/w/${workspace.slug}/approvals`} className="hover:text-primary">
              {t('approvals')}
            </Link>
            <Link href={`/w/${workspace.slug}/scheduled`} className="hover:text-primary">
              {t('scheduled')}
            </Link>
            <Link href={`/w/${workspace.slug}/audit`} className="hover:text-primary">
              {t('audit')}
            </Link>
            <Link href={`/w/${workspace.slug}/quickstart`} className="hover:text-primary">
              {t('quickstart')}
            </Link>
            <Link
              href={`/w/${workspace.slug}/settings`}
              className="hover:text-primary text-muted-foreground"
            >
              {t('settings')}
            </Link>
            <form action="/api/auth/logout" method="post">
              <button type="submit" className="text-muted-foreground hover:text-primary">
                {t('signOut')}
              </button>
            </form>
          </nav>
        </div>
      </header>
      {suspended && (
        <div role="status" className="bg-amber-50 text-amber-900 text-sm px-4 md:px-8 py-2">
          {t('suspended')}
        </div>
      )}
      <main className="flex-1 bg-muted/20">{props.children}</main>
    </div>
  );
}
