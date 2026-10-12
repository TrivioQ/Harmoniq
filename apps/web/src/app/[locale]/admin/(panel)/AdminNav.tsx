// Copyright The Harmoniq Authors
// SPDX-License-Identifier: Apache-2.0

'use client';

import { Link, usePathname } from '@/i18n/routing';

const active = 'bg-indigo-50 text-indigo-700';
const idle = 'text-gray-700 hover:bg-gray-50';

// INST-31: pages whose changes are for instance owners only are hidden from other roles
// (the registry refuses those changes whatever the panel shows).
const ITEMS = [
  ['dashboard', '/admin', false],
  ['health', '/admin/health', false],
  ['workspaces', '/admin/workspaces', false],
  ['orgs', '/admin/orgs', false],
  ['usage', '/admin/usage', false],
  ['users', '/admin/users', false],
  ['admins', '/admin/admins', true],
  ['apiKeys', '/admin/api-keys', true],
  ['storage', '/admin/storage', true],
  ['email', '/admin/email', true],
  ['auth', '/admin/auth', true],
  ['branding', '/admin/branding', true],
  ['settings', '/admin/settings', true],
  ['encryption', '/admin/encryption', true],
  ['audit', '/admin/audit', false],
] as const;

export type AdminNavLabels = Record<(typeof ITEMS)[number][0] | 'exitAdmin', string>;

export function AdminNav({ labels, owner }: { labels: AdminNavLabels; owner: boolean }) {
  // Locale-independent pathname, e.g. "/admin/workspaces".
  const pathname = usePathname();
  return (
    <nav className="p-4 space-y-1">
      {ITEMS.filter(([, , ownerOnly]) => owner || !ownerOnly).map(([key, href]) => {
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
