// Copyright The Harmoniq Authors
// SPDX-License-Identifier: Apache-2.0

import { redirect } from 'next/navigation';
import { Breadcrumbs, ContextSwitcher, UserMenu } from '@/components/AppShell';
import { getMe } from '@/lib/registry';

/** SES-02/03: the signed-in user's account. */
export default async function AccountLayout({ children }: { children: React.ReactNode }) {
  const me = await getMe();
  if (!me) redirect('/auth/login');
  return (
    <div className="min-h-screen flex flex-col">
      <header className="sticky top-0 z-50 w-full border-b bg-background/95 backdrop-blur">
        <div className="container flex h-14 items-center px-4 md:px-8">
          <div className="flex flex-1 items-center gap-4 min-w-0">
            <Breadcrumbs context={{ kind: 'admin' }} />
          </div>
          <nav className="flex items-center gap-4">
            <ContextSwitcher me={me} context={{ kind: 'admin' }} />
            <UserMenu me={me} />
          </nav>
        </div>
      </header>
      <main className="flex-1 bg-muted/20">
        <div className="p-6 md:p-8 space-y-6 max-w-3xl">{children}</div>
      </main>
    </div>
  );
}
