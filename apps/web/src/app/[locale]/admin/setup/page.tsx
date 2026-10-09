'use client';

import { useActionState } from 'react';
import { useTranslations } from 'next-intl';
import { Link } from '@/i18n/routing';
import { SetupState, initializeInstance } from './actions';

const input =
  'mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-indigo-500 focus:ring-indigo-500 sm:text-sm px-3 py-2 border';

// INST-01: first-boot wizard. Creates the first instance admin; that person then signs in
// with the same (verified) email address, which links their identity.
export default function AdminSetupPage() {
  const t = useTranslations('AdminSetupPage');
  const [state, action, pending] = useActionState<SetupState, FormData>(initializeInstance, {
    status: 'idle',
  });

  return (
    <div className="min-h-screen bg-gray-50 flex items-center justify-center p-4">
      <div className="w-full max-w-md bg-white p-8 rounded-xl shadow-lg border border-gray-100">
        <div className="text-center mb-8">
          <h1 className="text-2xl font-bold text-gray-900">{t('title')}</h1>
          <p className="text-gray-500 mt-2 text-sm">{t('description')}</p>
        </div>

        {state.status === 'success' ? (
          <div className="space-y-4 text-center">
            <div role="status" className="p-3 bg-green-50 text-green-700 text-sm rounded-md">
              {t('successMessage', { email: state.email })}
            </div>
            <Link href="/auth/login" className="text-indigo-600 hover:text-indigo-900 text-sm">
              {t('goToSignIn')}
            </Link>
          </div>
        ) : (
          <form action={action} className="space-y-5">
            <div>
              <label className="block text-sm font-medium text-gray-700" htmlFor="setupToken">
                {t('setupToken')}
              </label>
              <input
                id="setupToken"
                name="setupToken"
                type="password"
                required
                className={input}
                placeholder="HARMONIQ_SETUP_TOKEN"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700" htmlFor="email">
                {t('emailAddress')}
              </label>
              <input
                id="email"
                name="email"
                type="email"
                required
                className={input}
                placeholder="admin@example.com"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700" htmlFor="name">
                {t('name')}
              </label>
              <input
                id="name"
                name="name"
                type="text"
                className={input}
                placeholder="System Admin"
              />
            </div>

            {state.status === 'error' && (
              <div role="alert" className="p-3 bg-red-50 text-red-700 text-sm rounded-md">
                {state.message}
              </div>
            )}

            <button
              type="submit"
              disabled={pending}
              className="w-full flex justify-center py-2.5 px-4 border border-transparent rounded-md shadow-sm text-sm font-medium text-white bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50"
            >
              {pending ? t('initializing') : t('initialize')}
            </button>
          </form>
        )}
      </div>
    </div>
  );
}
