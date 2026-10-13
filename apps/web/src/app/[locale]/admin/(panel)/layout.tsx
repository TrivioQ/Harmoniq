// Copyright The Harmoniq Authors
// SPDX-License-Identifier: Apache-2.0

import { notFound, redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { getMe } from '@/lib/registry';
import { getBranding } from '@/lib/branding';
import { AdminNav } from './AdminNav';
import { ContextSwitcher, UserMenu } from '@/components/AppShell';

// INST-05/06: the panel is only for instance admins. Workspace owners get a 404, not a
// hint that the page exists. The registry enforces the same rule on every admin API.
export default async function AdminPanelLayout({ children }: { children: React.ReactNode }) {
  const me = await getMe();
  if (!me) redirect('/auth/login');
  if (!me.user.isInstanceAdmin) notFound();

  const t = await getTranslations('AdminLayout');
  return (
    <div className="flex h-screen bg-gray-100">
      <aside className="w-64 bg-white border-r border-gray-200 flex flex-col">
        <div className="h-16 flex items-center px-6 border-b border-gray-200">
          <span className="text-lg font-bold text-gray-900">
            {t('title', { name: (await getBranding()).name })}
          </span>
        </div>
        <AdminNav
          owner={(me.instanceAdmin?.capabilities ?? ['owner']).includes('owner')}
          labels={{
            dashboard: t('dashboard'),
            health: t('health'),
            jobs: t('jobs'),
            announcements: t('announcements'),
            security: t('security'),
            workspaces: t('workspaces'),
            orgs: t('orgs'),
            usage: t('usage'),
            users: t('users'),
            admins: t('admins'),
            storage: t('storage'),
            email: t('email'),
            auth: t('auth'),
            branding: t('branding'),
            settings: t('settings'),
            apiKeys: t('apiKeys'),
            encryption: t('encryption'),
            audit: t('audit'),
            exitAdmin: t('exitAdmin'),
          }}
        />
      </aside>
      <main className="flex-1 overflow-auto bg-gray-50 p-8">
        {/* TAD-08: the same switcher and user menu as the org and workspace pages. */}
        <div className="mb-6 flex justify-end items-center gap-3">
          <ContextSwitcher me={me} context={{ kind: 'admin' }} />
          <UserMenu me={me} />
        </div>
        {children}
      </main>
    </div>
  );
}
