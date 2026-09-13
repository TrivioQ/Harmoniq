'use client';

import React from 'react';
import { Link } from '@/i18n/routing';
import { usePathname } from 'next/navigation';
import { useTranslations } from 'next-intl';

export default function AdminLayout({ children }: { children: React.ReactNode }) {
  const t = useTranslations('AdminLayout');
  const pathname = usePathname();

  if (pathname === '/admin/setup') {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center p-4">{children}</div>
    );
  }

  return (
    <div className="flex h-screen bg-gray-100">
      <aside className="w-64 bg-white border-r border-gray-200">
        <div className="h-16 flex items-center px-6 border-b border-gray-200">
          <span className="text-lg font-bold text-gray-900">{t('title')}</span>
        </div>
        <nav className="p-4 space-y-1">
          <Link
            href="/admin"
            className={`flex items-center px-4 py-2 text-sm font-medium rounded-md ${pathname === '/en/admin' || pathname === '/es/admin' || pathname === '/admin' ? 'bg-indigo-50 text-indigo-700' : 'text-gray-700 hover:bg-gray-50'}`}
          >
            {t('dashboard')}
          </Link>
          <Link
            href="/admin/workspaces"
            className={`flex items-center px-4 py-2 text-sm font-medium rounded-md ${pathname?.includes('/admin/workspaces') ? 'bg-indigo-50 text-indigo-700' : 'text-gray-700 hover:bg-gray-50'}`}
          >
            {t('workspaces')}
          </Link>
          <Link
            href="/"
            className="flex items-center px-4 py-2 text-sm font-medium rounded-md text-gray-500 hover:text-gray-700 mt-8"
          >
            {t('exitAdmin')}
          </Link>
        </nav>
      </aside>
      <main className="flex-1 overflow-auto bg-gray-50 p-8">{children}</main>
    </div>
  );
}
