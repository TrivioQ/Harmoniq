// Copyright The Harmoniq Authors
// SPDX-License-Identifier: Apache-2.0

import { getTranslations } from 'next-intl/server';
import type { MeResponse } from '@harmoniq/core/dist/schemas/AuthSchemas';
import { Link } from '@/i18n/routing';
import { BrandMark } from './BrandMark';

// TAD-08: the navigation the org, workspace and admin layouts share: breadcrumbs, an
// organization and workspace switcher, and a user menu. Plain <details> menus: they work
// without client JavaScript.

export type ShellContext =
  | { kind: 'org'; slug: string; name: string }
  | { kind: 'workspace'; slug: string; name: string; org?: { slug: string; name: string } }
  | { kind: 'admin' };

const menu =
  'absolute z-50 mt-2 w-72 max-h-[70vh] overflow-y-auto rounded-md border bg-background p-2 shadow-lg text-sm';
const item = 'block rounded px-2 py-1.5 hover:bg-muted';

/** Brand / organization / workspace, each a link up. */
export function Breadcrumbs({ context }: { context: ShellContext }) {
  const sep = <span className="text-muted-foreground text-sm">/</span>;
  return (
    <div className="flex items-center gap-3 min-w-0">
      <BrandMark />
      {context.kind === 'org' && (
        <>
          {sep}
          <Link href={`/orgs/${context.slug}`} className="font-medium text-sm truncate">
            {context.name}
          </Link>
        </>
      )}
      {context.kind === 'workspace' && (
        <>
          {context.org && (
            <>
              {sep}
              <Link
                href={`/orgs/${context.org.slug}`}
                className="text-sm text-muted-foreground hover:text-primary truncate"
              >
                {context.org.name}
              </Link>
            </>
          )}
          {sep}
          <Link href={`/w/${context.slug}`} className="font-medium text-sm truncate">
            {context.name}
          </Link>
        </>
      )}
    </div>
  );
}

/** Jump to any organization or workspace you belong to. */
export async function ContextSwitcher({ me, context }: { me: MeResponse; context: ShellContext }) {
  const t = await getTranslations('Shell');
  const current = context.kind === 'admin' ? null : context.slug;
  const orgName = new Map(me.organizations.map((o) => [o.slug, o.name]));
  const standalone = me.workspaces.filter((w) => !w.organization);
  const byOrg = me.organizations.map((o) => ({
    ...o,
    workspaces: me.workspaces.filter((w) => w.organization === o.slug),
  }));
  // Workspaces of organizations you are not a member of (e.g. through a workspace invite).
  const otherOrgs = [
    ...new Set(
      me.workspaces.map((w) => w.organization).filter((o): o is string => !!o && !orgName.has(o))
    ),
  ];

  return (
    <details className="relative">
      <summary className="cursor-pointer list-none rounded-md border px-2 py-1 text-sm hover:bg-muted">
        {t('switch')} ▾
      </summary>
      <div className={menu}>
        {byOrg.map((o) => (
          <div key={o.slug} className="mb-2">
            <Link
              href={`/orgs/${o.slug}`}
              className={`${item} font-medium ${current === o.slug ? 'bg-muted' : ''}`}
            >
              {o.name}
            </Link>
            {o.workspaces.map((w) => (
              <Link
                key={w.slug}
                href={`/w/${w.slug}`}
                className={`${item} pl-5 ${current === w.slug ? 'bg-muted' : ''}`}
              >
                {w.name}
              </Link>
            ))}
          </div>
        ))}
        {[...otherOrgs.map((o) => ({ org: o })), { org: null }].map(({ org }) => {
          const list = org ? me.workspaces.filter((w) => w.organization === org) : standalone;
          if (!list.length) return null;
          return (
            <div key={org ?? '-'} className="mb-2">
              <p className="px-2 py-1 text-xs text-muted-foreground">{org ?? t('standalone')}</p>
              {list.map((w) => (
                <Link
                  key={w.slug}
                  href={`/w/${w.slug}`}
                  className={`${item} pl-5 ${current === w.slug ? 'bg-muted' : ''}`}
                >
                  {w.name}
                </Link>
              ))}
            </div>
          );
        })}
        <Link href="/" className={`${item} border-t mt-1 pt-2 text-muted-foreground`}>
          {t('allWorkspaces')}
        </Link>
      </div>
    </details>
  );
}

/** Who you are signed in as, the admin panel for instance admins, and sign-out. */
export async function UserMenu({ me }: { me: MeResponse }) {
  const t = await getTranslations('Shell');
  const initial = (me.user.name || me.user.email).slice(0, 1).toUpperCase();
  return (
    <details className="relative">
      <summary
        className="cursor-pointer list-none flex h-8 w-8 items-center justify-center rounded-full bg-muted text-sm font-medium"
        aria-label={t('account')}
      >
        {initial}
      </summary>
      <div className={`${menu} right-0 w-60`}>
        <p className="px-2 py-1.5 text-xs text-muted-foreground truncate">{me.user.email}</p>
        <Link href="/" className={item}>
          {t('home')}
        </Link>
        {me.user.isInstanceAdmin && (
          <Link href="/admin" className={item}>
            {t('admin')}
          </Link>
        )}
        <form action="/api/auth/logout" method="post" className="border-t mt-1 pt-1">
          <button type="submit" className={`${item} w-full text-left`}>
            {t('signOut')}
          </button>
        </form>
      </div>
    </details>
  );
}
