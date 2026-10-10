import { getTranslations } from 'next-intl/server';
import { Link } from '@/i18n/routing';
import { registryFetch } from '@/lib/registry';
import { SetupWizard } from './SetupWizard';

// INST-01: the first-boot wizard. It creates the first instance admin, who then signs in
// with the same (verified) email address, which links their identity.
export default async function AdminSetupPage() {
  const t = await getTranslations('AdminSetupPage');
  const status = await registryFetch<{ needed: boolean; tokenConfigured: boolean }>(
    '/api/admin/setup'
  ).catch(() => null);

  return (
    <div className="min-h-screen bg-gray-50 flex items-center justify-center p-4">
      <div className="w-full max-w-lg bg-white p-8 rounded-xl shadow-lg border border-gray-100">
        <div className="text-center mb-6">
          <h1 className="text-2xl font-bold text-gray-900">{t('title')}</h1>
          <p className="text-gray-500 mt-2 text-sm">{t('description')}</p>
        </div>
        {status && !status.needed ? (
          <div className="space-y-4 text-center">
            <p className="text-sm text-gray-600">{t('alreadyDone')}</p>
            <Link href="/auth/login" className="text-indigo-600 hover:text-indigo-900 text-sm">
              {t('goToSignIn')}
            </Link>
          </div>
        ) : status && !status.tokenConfigured ? (
          <p className="text-sm text-red-700">{t('noToken')}</p>
        ) : (
          <SetupWizard />
        )}
      </div>
    </div>
  );
}
