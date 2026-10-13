// Copyright The Harmoniq Authors
// SPDX-License-Identifier: Apache-2.0

import { notFound, redirect } from 'next/navigation';
import { getFormatter, getTranslations } from 'next-intl/server';
import { Link } from '@/i18n/routing';
import { Breadcrumbs, ContextSwitcher, UserMenu } from '@/components/AppShell';
import { getMe } from '@/lib/registry';
import { orgApi } from '@/lib/orgApi';
import { SupportBanner } from '@/components/SupportBanner';
import { ReadOnly } from '@/components/ReadOnly';

/** ORG-15: `/orgs/:orgSlug/…`, next to the workspace routes. */
export default async function OrgLayout(props: {
  children: React.ReactNode;
  params: Promise<{ orgSlug: string }>;
}) {
  const t = await getTranslations('OrgLayout');
  const format = await getFormatter();
  const { orgSlug } = await props.params;
  const me = await getMe();
  if (!me) redirect('/auth/login');
  const member = me.organizations.find((o) => o.slug === orgSlug);
  // INST-20: an instance admin with an active support grant reads the organization as its
  // admins would, and changes nothing. Org admins see who has such access.
  const home =
    member?.role === 'org_admin' || (!member && me.user.isInstanceAdmin)
      ? await orgApi.home(orgSlug, { limit: '1' }).catch(() => null)
      : null;
  const supportMode = !member && !!home?.support;
  if (!member && !supportMode) notFound();
  const org = member ?? { slug: home!.slug, name: home!.name, role: null };
  const base = `/orgs/${org.slug}`;
  const admin = org.role === 'org_admin';
  // Pages for org admins; read-only through support access.
  const manage = admin || supportMode;
  // PPL-08: auditors read the audit log and the people directory.
  const reader = manage || org.role === 'org_auditor';
  // PPL-08: billing members read plan and usage.
  const billing = reader || org.role === 'org_billing';
  const myGrant = supportMode
    ? home?.supportAccess?.find((g) => g.admin === me.user.email)
    : undefined;

  return (
    <div className="min-h-screen flex flex-col">
      <header className="sticky top-0 z-50 w-full border-b bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60">
        <div className="container flex h-14 items-center px-4 md:px-8">
          <div className="flex flex-1 items-center gap-4 min-w-0">
            <Breadcrumbs context={{ kind: 'org', slug: org.slug, name: org.name }} />
          </div>
          <nav className="flex flex-wrap items-center gap-x-6 gap-y-1 text-sm font-medium">
            <Link href={base} className="hover:text-primary">
              {t('overview')}
            </Link>
            <Link href={`${base}/catalog`} className="hover:text-primary">
              {t('catalog')}
            </Link>
            {reader && (
              <Link href={`${base}/audit`} className="hover:text-primary">
                {t('audit')}
              </Link>
            )}
            {reader && (
              <Link href={`${base}/people`} className="hover:text-primary">
                {t('people')}
              </Link>
            )}
            <Link href={`${base}/members`} className="hover:text-primary">
              {t('members')}
            </Link>
            {manage && (
              <Link href={`${base}/keys`} className="hover:text-primary">
                {t('keys')}
              </Link>
            )}
            {manage && (
              <Link href={`${base}/sso`} className="hover:text-primary">
                {t('sso')}
              </Link>
            )}
            {manage && (
              <Link href={`${base}/provisioning`} className="hover:text-primary">
                {t('provisioning')}
              </Link>
            )}
            {billing && (
              <Link href={`${base}/usage`} className="hover:text-primary">
                {t('usage')}
              </Link>
            )}
            {reader && (
              <Link href={`${base}/policies`} className="hover:text-primary">
                {t('policies')}
              </Link>
            )}
            {manage && (
              <Link href={`${base}/integrations`} className="hover:text-primary">
                {t('integrations')}
              </Link>
            )}
            {manage && (
              <Link href={`${base}/settings`} className="hover:text-primary">
                {t('settings')}
              </Link>
            )}
            <ContextSwitcher me={me} context={{ kind: 'org', slug: org.slug, name: org.name }} />
            <UserMenu me={me} />
          </nav>
        </div>
      </header>
      {admin && <SupportBanner grants={home?.supportAccess} />}
      {supportMode && (
        <div role="status" className="bg-blue-50 text-blue-900 text-sm px-4 md:px-8 py-2">
          {myGrant
            ? t('supportView', { until: format.dateTime(new Date(myGrant.expiresAt), 'short') })
            : t('supportViewShort')}
        </div>
      )}
      <main className="flex-1 bg-muted/20">
        <ReadOnly reason={supportMode ? t('supportReadOnly') : null}>
          <div className="p-6 md:p-8 space-y-6 max-w-6xl">{props.children}</div>
        </ReadOnly>
      </main>
    </div>
  );
}
