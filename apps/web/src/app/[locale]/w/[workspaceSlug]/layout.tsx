// Copyright The Harmoniq Authors
// SPDX-License-Identifier: Apache-2.0

import { notFound, redirect } from 'next/navigation';
import { Link } from '@/i18n/routing';
import { Breadcrumbs, ContextSwitcher, UserMenu, type ShellContext } from '@/components/AppShell';
import { getTranslations } from 'next-intl/server';
import { getMe } from '@/lib/registry';
import { workspaceApi } from '@/lib/workspaceApi';
import { nearLimits } from '@/lib/usage';
import { SupportBanner } from '@/components/SupportBanner';

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

  // PLN-05: admins see quotas at 80% or more on every page (usage is admin-only).
  const role = me.workspaces.find((w) => w.slug === workspace.slug)?.role;
  const near =
    role === 'owner' || role === 'admin'
      ? await workspaceApi
          .usage(workspace.slug, 1)
          .then((u) => nearLimits(u.workspace))
          .catch(() => [])
      : [];

  // INST-20: admins see who has support access to the workspace.
  const support =
    role === 'owner' || role === 'admin'
      ? 'supportAccess' in workspace
        ? workspace.supportAccess
        : await workspaceApi
            .get(workspace.slug)
            .then((w) => w.supportAccess)
            .catch(() => undefined)
      : undefined;

  // TAD-08: the organization in the breadcrumbs, when you can see it.
  const orgSlug = me.workspaces.find((w) => w.slug === workspace.slug)?.organization;
  const org = orgSlug ? me.organizations.find((o) => o.slug === orgSlug) : undefined;
  const context: ShellContext = {
    kind: 'workspace',
    slug: workspace.slug,
    name: workspace.name,
    ...(org && { org: { slug: org.slug, name: org.name } }),
  };

  return (
    <div className="min-h-screen flex flex-col">
      <header className="sticky top-0 z-50 w-full border-b bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60">
        <div className="container flex h-14 items-center px-4 md:px-8">
          <div className="flex flex-1 items-center gap-4 min-w-0">
            <Breadcrumbs context={context} />
          </div>
          <nav className="flex flex-wrap items-center gap-x-6 gap-y-1 text-sm font-medium">
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
            <ContextSwitcher me={me} context={context} />
            <UserMenu me={me} />
          </nav>
        </div>
      </header>
      {near.length > 0 && (
        <div role="status" className="bg-amber-50 text-amber-900 text-sm px-4 md:px-8 py-2">
          {t('quotaWarning', {
            quotas: near.map((q) => t(`quotaName.${q.quota}`)).join(', '),
          })}{' '}
          <Link href={`/w/${workspace.slug}/settings`} className="underline">
            {t('quotaDetails')}
          </Link>
        </div>
      )}
      <SupportBanner grants={support} />
      {suspended && (
        <div role="status" className="bg-amber-50 text-amber-900 text-sm px-4 md:px-8 py-2">
          {t('suspended')}
        </div>
      )}
      <main className="flex-1 bg-muted/20">{props.children}</main>
    </div>
  );
}
