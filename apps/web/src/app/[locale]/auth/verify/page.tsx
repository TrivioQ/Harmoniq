import { getTranslations } from 'next-intl/server';
import { Link } from '@/i18n/routing';

// Landing page for the emailed link. Sign-in happens on an explicit POST, so mail
// scanners that prefetch links cannot use up the one-time token.
export default async function VerifyEmailPage(props: {
  searchParams: Promise<{ token?: string }>;
}) {
  const t = await getTranslations('VerifyPage');
  const { token } = await props.searchParams;

  return (
    <div className="flex min-h-screen items-center justify-center bg-muted/50 p-6">
      <div className="w-full max-w-sm bg-card border rounded-xl shadow-sm p-6 space-y-4">
        <h1 className="font-semibold text-2xl">{t('title')}</h1>
        {token ? (
          <form action="/api/auth/email/verify" method="post" className="space-y-3">
            <input type="hidden" name="token" value={token} />
            <p className="text-sm text-muted-foreground">{t('description')}</p>
            <button
              type="submit"
              className="w-full rounded-md bg-primary text-primary-foreground px-4 py-2 text-sm font-medium"
            >
              {t('continue')}
            </button>
          </form>
        ) : (
          <p className="text-sm text-muted-foreground">{t('missingToken')}</p>
        )}
        <Link href="/auth/login" className="text-sm text-primary hover:underline">
          {t('back')}
        </Link>
      </div>
    </div>
  );
}
