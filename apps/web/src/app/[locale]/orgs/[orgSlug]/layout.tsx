import { notFound, redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { Link } from '@/i18n/routing';
import { BrandMark } from '@/components/BrandMark';
import { getMe } from '@/lib/registry';

/** ORG-15: `/orgs/:orgSlug/…`, next to the workspace routes. */
export default async function OrgLayout(props: {
  children: React.ReactNode;
  params: Promise<{ orgSlug: string }>;
}) {
  const t = await getTranslations('OrgLayout');
  const { orgSlug } = await props.params;
  const me = await getMe();
  if (!me) redirect('/auth/login');
  const org = me.organizations.find((o) => o.slug === orgSlug);
  if (!org) notFound();
  const base = `/orgs/${org.slug}`;
  const admin = org.role === 'org_admin';

  return (
    <div className="min-h-screen flex flex-col">
      <header className="sticky top-0 z-50 w-full border-b bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60">
        <div className="container flex h-14 items-center px-4 md:px-8">
          <div className="flex flex-1 items-center gap-4">
            <BrandMark />
            <span className="text-muted-foreground text-sm">/</span>
            <span className="font-medium text-sm">{org.name}</span>
          </div>
          <nav className="flex items-center gap-6 text-sm font-medium">
            <Link href={base} className="hover:text-primary">
              {t('overview')}
            </Link>
            <Link href={`${base}/catalog`} className="hover:text-primary">
              {t('catalog')}
            </Link>
            {admin && (
              <Link href={`${base}/audit`} className="hover:text-primary">
                {t('audit')}
              </Link>
            )}
            <Link href={`${base}/members`} className="hover:text-primary">
              {t('members')}
            </Link>
            {admin && (
              <Link href={`${base}/keys`} className="hover:text-primary">
                {t('keys')}
              </Link>
            )}
            {admin && (
              <Link href={`${base}/sso`} className="hover:text-primary">
                {t('sso')}
              </Link>
            )}
            {admin && (
              <Link href={`${base}/provisioning`} className="hover:text-primary">
                {t('provisioning')}
              </Link>
            )}
          </nav>
        </div>
      </header>
      <main className="flex-1 bg-muted/20">
        <div className="p-6 md:p-8 space-y-6 max-w-6xl">{props.children}</div>
      </main>
    </div>
  );
}
