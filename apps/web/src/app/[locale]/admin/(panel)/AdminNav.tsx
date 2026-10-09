'use client';

import { Link, usePathname } from '@/i18n/routing';

const active = 'bg-indigo-50 text-indigo-700';
const idle = 'text-gray-700 hover:bg-gray-50';

export function AdminNav({
  labels,
}: {
  labels: { dashboard: string; workspaces: string; exitAdmin: string };
}) {
  // Locale-independent pathname, e.g. "/admin/workspaces".
  const pathname = usePathname();
  return (
    <nav className="p-4 space-y-1">
      <Link
        href="/admin"
        className={`flex items-center px-4 py-2 text-sm font-medium rounded-md ${pathname === '/admin' ? active : idle}`}
      >
        {labels.dashboard}
      </Link>
      <Link
        href="/admin/workspaces"
        className={`flex items-center px-4 py-2 text-sm font-medium rounded-md ${pathname.startsWith('/admin/workspaces') ? active : idle}`}
      >
        {labels.workspaces}
      </Link>
      <Link
        href="/"
        className="flex items-center px-4 py-2 text-sm font-medium rounded-md text-gray-500 hover:text-gray-700 mt-8"
      >
        {labels.exitAdmin}
      </Link>
    </nav>
  );
}
