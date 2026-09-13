import { PrismaClient } from '@harmoniq/db';
import { getSession } from '@/lib/auth';
import { redirect } from 'next/navigation';
import { Link } from '@/i18n/routing';
import { getTranslations } from 'next-intl/server';

const db = new PrismaClient();

export default async function WorkspaceLayout(props: {
  children: React.ReactNode;
  params: Promise<{ workspaceSlug: string }>;
}) {
  const t = await getTranslations('WorkspaceLayout');
  const params = await props.params;
  const session = await getSession();
  if (!session) redirect('/auth/login');

  const workspace = await db.workspace.findUnique({
    where: { slug: params.workspaceSlug }
  });

  if (!workspace) {
    redirect('/');
  }

  return (
    <div className="min-h-screen flex flex-col">
      <header className="sticky top-0 z-50 w-full border-b bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60">
        <div className="container flex h-14 items-center px-4 md:px-8">
          <div className="flex flex-1 items-center gap-4">
            <Link href="/" className="font-semibold text-lg hover:text-primary transition-colors">
              Harmoniq
            </Link>
            <span className="text-muted-foreground text-sm">/</span>
            <span className="font-medium text-sm">{workspace.name}</span>
          </div>
          <nav className="flex items-center gap-6 text-sm font-medium">
            <Link href={`/${workspace.slug}`} className="hover:text-primary">{t('overview')}</Link>
            <Link href={`/${workspace.slug}/modules`} className="hover:text-primary">{t('modules')}</Link>
            <Link href={`/${workspace.slug}/environments`} className="hover:text-primary">{t('environments')}</Link>
            <Link href={`/${workspace.slug}/settings`} className="hover:text-primary text-muted-foreground">{t('settings')}</Link>
          </nav>
        </div>
      </header>
      <main className="flex-1 bg-muted/20">
        {props.children}
      </main>
    </div>
  );
}
