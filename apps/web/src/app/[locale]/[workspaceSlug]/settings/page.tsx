import { getTranslations } from 'next-intl/server';

export default async function SettingsPage() {
  const t = await getTranslations('SettingsPage');
  return (
    <div className="container p-6 md:p-10 max-w-6xl space-y-8">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-3xl font-bold tracking-tight">{t('title')}</h2>
          <p className="text-muted-foreground mt-2">
            {t('description')}
          </p>
        </div>
      </div>
      
      <div className="rounded-xl border bg-card text-card-foreground shadow-sm p-6">
        <h3 className="font-semibold mb-4">{t('apiKeys')}</h3>
        <p className="text-sm text-muted-foreground mb-4">{t('apiKeysDescription')}</p>
        <button className="inline-flex items-center justify-center whitespace-nowrap rounded-md text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50 border border-input bg-background shadow-sm hover:bg-accent hover:text-accent-foreground h-9 px-4 py-2">
          {t('generateKey')}
        </button>
      </div>
    </div>
  );
}
