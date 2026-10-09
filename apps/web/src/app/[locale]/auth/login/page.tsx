import { getTranslations } from 'next-intl/server';
import type { AuthProviderSummary } from '@harmoniq/core/dist/schemas/AuthSchemas';
import { Button } from '@/components/ui/button';
import { registryFetch } from '@/lib/registry';

const KNOWN_ERRORS = [
  'invalid_state',
  'access_denied',
  'email_not_verified',
  'invalid_grant',
  'provider_unavailable',
  'dev_login_disabled',
  'invalid_token',
  'invalid_code',
  'other_browser',
] as const;

const linkButton =
  'w-full inline-flex items-center justify-center whitespace-nowrap rounded-md text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring border border-input bg-background shadow-sm hover:bg-accent hover:text-accent-foreground h-9 px-4 py-2';

async function loadProviders(): Promise<AuthProviderSummary[] | null> {
  try {
    return (await registryFetch<{ providers: AuthProviderSummary[] }>('/api/auth/providers'))
      .providers;
  } catch {
    return null;
  }
}

export default async function LoginPage(props: {
  searchParams: Promise<{ error?: string; sent?: string; email?: string }>;
}) {
  const t = await getTranslations('LoginPage');
  const { error, sent, email: sentTo } = await props.searchParams;
  const providers = await loadProviders();

  const errorKey = KNOWN_ERRORS.find((e) => e === error);
  const redirectProviders = providers?.filter((p) => p.kind === 'redirect') ?? [];
  const devLogin = providers?.some((p) => p.kind === 'dev');
  const emailLogin = providers?.some((p) => p.kind === 'email');

  return (
    <div className="flex min-h-screen items-center justify-center bg-muted/50 p-6 md:p-10">
      <div className="w-full max-w-sm bg-card text-card-foreground border rounded-xl shadow-sm">
        <div className="flex flex-col space-y-1.5 p-6">
          <h3 className="font-semibold tracking-tight text-2xl">{t('title')}</h3>
          <p className="text-sm text-muted-foreground">{t('description')}</p>
        </div>
        <div className="p-6 pt-0 space-y-4">
          {error && (
            <div role="alert" className="p-3 text-sm rounded-md bg-red-50 text-red-700">
              {errorKey ? t(`errors.${errorKey}`) : t('errors.generic')}
            </div>
          )}

          {providers === null && (
            <div role="alert" className="p-3 text-sm rounded-md bg-amber-50 text-amber-800">
              {t('registryUnavailable')}
            </div>
          )}

          {emailLogin &&
            (sent ? (
              <div className="space-y-3">
                <p role="status" className="p-3 text-sm rounded-md bg-green-50 text-green-800">
                  {t('emailSent', { email: sentTo ?? '' })}
                </p>
                <form action="/api/auth/email/code" method="post" className="space-y-2">
                  <input type="hidden" name="email" value={sentTo ?? ''} />
                  <label className="block text-sm font-medium" htmlFor="code">
                    {t('codeLabel')}
                  </label>
                  <input
                    id="code"
                    name="code"
                    required
                    inputMode="numeric"
                    autoComplete="one-time-code"
                    pattern="[0-9]{6}"
                    maxLength={6}
                    className="block w-full rounded-md border px-3 py-2 text-sm tracking-widest font-mono"
                  />
                  <Button type="submit" className="w-full">
                    {t('codeSubmit')}
                  </Button>
                </form>
              </div>
            ) : (
              <form action="/api/auth/email/request" method="post" className="space-y-2">
                <label className="block text-sm font-medium" htmlFor="email">
                  {t('emailLabel')}
                </label>
                <input
                  id="email"
                  name="email"
                  type="email"
                  required
                  autoComplete="email"
                  placeholder="you@example.com"
                  className="block w-full rounded-md border px-3 py-2 text-sm"
                />
                <Button type="submit" className="w-full">
                  {t('emailSubmit')}
                </Button>
              </form>
            ))}

          {redirectProviders.map((provider) => (
            // Plain anchor: this is a full-page navigation to a route handler, not a page.
            <a key={provider.id} href={`/api/auth/login/${provider.id}`} className={linkButton}>
              {t('continueWith', { provider: provider.displayName })}
            </a>
          ))}

          {devLogin && (
            <form action="/api/auth/dev" method="post" className="space-y-2">
              <label className="block text-sm font-medium" htmlFor="dev-email">
                {t('devLogin')}
              </label>
              <input
                id="dev-email"
                name="email"
                type="email"
                required
                placeholder="you@example.com"
                className="block w-full rounded-md border px-3 py-2 text-sm"
              />
              <Button type="submit" className="w-full" variant="outline">
                {t('devLoginSubmit')}
              </Button>
              <p className="text-xs text-muted-foreground">{t('devLoginHint')}</p>
            </form>
          )}

          {providers?.length === 0 && (
            <p className="text-sm text-muted-foreground">{t('noProviders')}</p>
          )}

          <div className="relative">
            <div className="absolute inset-0 flex items-center">
              <span className="w-full border-t" />
            </div>
            <div className="relative flex justify-center text-xs uppercase">
              <span className="bg-card px-2 text-muted-foreground">{t('or')}</span>
            </div>
          </div>

          <Button className="w-full" variant="outline" disabled>
            <span>{t('continueWithSaml')}</span>
          </Button>
        </div>
      </div>
    </div>
  );
}
