'use client';

import React, { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';

export default function AdminSetupPage() {
  const t = useTranslations('AdminSetupPage');
  const router = useRouter();
  const [formData, setFormData] = useState({ setupToken: '', email: '', name: '' });
  const [status, setStatus] = useState<'idle' | 'loading' | 'success' | 'error'>('idle');
  const [errorMessage, setErrorMessage] = useState('');

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setStatus('loading');
    try {
      const res = await fetch(
        `${process.env.NEXT_PUBLIC_REGISTRY_URL || 'http://localhost:3002'}/api/admin/setup`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(formData),
        }
      );

      const data = await res.json();
      if (!res.ok) throw new Error(data.error?.message || t('errorSetup'));

      localStorage.setItem('harmoniq_admin_token', data.token);
      setStatus('success');
      setTimeout(() => router.push('/admin'), 1500);
    } catch (err: unknown) {
      setErrorMessage(err instanceof Error ? err.message : String(err));
      setStatus('error');
    }
  };

  return (
    <div className="w-full max-w-md bg-white p-8 rounded-xl shadow-lg border border-gray-100">
      <div className="text-center mb-8">
        <h1 className="text-2xl font-bold text-gray-900">{t('title')}</h1>
        <p className="text-gray-500 mt-2 text-sm">{t('description')}</p>
      </div>

      <form onSubmit={handleSubmit} className="space-y-5">
        <div>
          <label className="block text-sm font-medium text-gray-700">{t('setupToken')}</label>
          <input
            type="password"
            required
            className="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-indigo-500 focus:ring-indigo-500 sm:text-sm px-3 py-2 border"
            value={formData.setupToken}
            onChange={(e) => setFormData({ ...formData, setupToken: e.target.value })}
            placeholder="HARMONIQ_SETUP_TOKEN"
          />
        </div>
        <div>
          <label className="block text-sm font-medium text-gray-700">{t('emailAddress')}</label>
          <input
            type="email"
            required
            className="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-indigo-500 focus:ring-indigo-500 sm:text-sm px-3 py-2 border"
            value={formData.email}
            onChange={(e) => setFormData({ ...formData, email: e.target.value })}
            placeholder="admin@example.com"
          />
        </div>
        <div>
          <label className="block text-sm font-medium text-gray-700">{t('name')}</label>
          <input
            type="text"
            required
            className="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-indigo-500 focus:ring-indigo-500 sm:text-sm px-3 py-2 border"
            value={formData.name}
            onChange={(e) => setFormData({ ...formData, name: e.target.value })}
            placeholder="System Admin"
          />
        </div>

        {status === 'error' && (
          <div className="p-3 bg-red-50 text-red-700 text-sm rounded-md">{errorMessage}</div>
        )}

        {status === 'success' && (
          <div className="p-3 bg-green-50 text-green-700 text-sm rounded-md">
            {t('successMessage')}
          </div>
        )}

        <button
          type="submit"
          disabled={status === 'loading' || status === 'success'}
          className="w-full flex justify-center py-2.5 px-4 border border-transparent rounded-md shadow-sm text-sm font-medium text-white bg-indigo-600 hover:bg-indigo-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-indigo-500 disabled:opacity-50"
        >
          {status === 'loading' ? t('initializing') : t('initialize')}
        </button>
      </form>
    </div>
  );
}
