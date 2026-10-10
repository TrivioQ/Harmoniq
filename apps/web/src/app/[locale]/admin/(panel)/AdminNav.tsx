// Copyright The Harmoniq Authors
// SPDX-License-Identifier: Apache-2.0

'use client';

import { Link, usePathname } from '@/i18n/routing';

const active = 'bg-indigo-50 text-indigo-700';
const idle = 'text-gray-700 hover:bg-gray-50';

const ITEMS = [
  ['dashboard', '/admin'],
  ['health', '/admin/health'],
  ['workspaces', '/admin/workspaces'],
  ['orgs', '/admin/orgs'],
  ['users', '/admin/users'],
  ['admins', '/admin/admins'],
  ['storage', '/admin/storage'],
  ['email', '/admin/email'],
  ['auth', '/admin/auth'],
  ['branding', '/admin/branding'],
  ['audit', '/admin/audit'],
] as const;

export type AdminNavLabels = Record<(typeof ITEMS)[number][0] | 'exitAdmin', string>;

export function AdminNav({ labels }: { labels: AdminNavLabels }) {
  // Locale-independent pathname, e.g. "/admin/workspaces".
  const pathname = usePathname();
  return (
    <nav className="p-4 space-y-1">
      {ITEMS.map(([key, href]) => {
        const current = href === '/admin' ? pathname === href : pathname.startsWith(href);
        return (
          <Link
            key={key}
            href={href}
            className={`flex items-center px-4 py-2 text-sm font-medium rounded-md ${current ? active : idle}`}
          >
            {labels[key]}
          </Link>
        );
      })}
      <Link
        href="/"
        className="flex items-center px-4 py-2 text-sm font-medium rounded-md text-gray-500 hover:text-gray-700 mt-8"
      >
        {labels.exitAdmin}
      </Link>
    </nav>
  );
}
