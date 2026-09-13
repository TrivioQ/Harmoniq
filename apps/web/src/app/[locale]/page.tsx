import { PrismaClient } from '@harmoniq/db';
import { getSession } from '@/lib/auth';
import { redirect } from 'next/navigation';
import { Link } from '@/i18n/routing';
import { Button } from '@/components/ui/button';
import { getTranslations } from 'next-intl/server';

const db = new PrismaClient();

export default async function WorkspaceSelector() {
  const t = await getTranslations('WorkspaceSelector');
  const session = await getSession();
  if (!session) {
    redirect('/auth/login');
  }

  const workspaces = await db.workspace.findMany({
    where: {
      WorkspaceMembers: {
        some: { userId: session.userId },
      },
    },
    orderBy: { name: 'asc' },
  });

  return (
    <div className="flex flex-col min-h-screen items-center p-6 md:p-24 bg-muted/30">
      <div className="w-full max-w-2xl space-y-8">
        <div>
          <h1 className="text-3xl font-semibold tracking-tight">{t('title')}</h1>
          <p className="text-muted-foreground mt-2">{t('description')}</p>
        </div>

        <div className="grid gap-4">
          {workspaces.map((ws) => (
            <Link key={ws.id} href={`/${ws.slug}`}>
              <div className="p-6 border rounded-xl bg-card hover:border-primary transition-colors cursor-pointer shadow-sm">
                <h3 className="font-medium text-lg">{ws.name}</h3>
                <p className="text-sm text-muted-foreground">{ws.slug}</p>
              </div>
            </Link>
          ))}
          {workspaces.length === 0 && (
            <div className="p-8 border border-dashed rounded-xl text-center">
              <p className="text-muted-foreground mb-4">{t('noWorkspaces')}</p>
              <Button>{t('createWorkspace')}</Button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
