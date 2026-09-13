import { Button } from '@/components/ui/button';
import Link from 'next/link';
import { useTranslations } from 'next-intl';

export default function LoginPage() {
  const t = useTranslations('LoginPage');
  return (
    <div className="flex min-h-screen items-center justify-center bg-muted/50 p-6 md:p-10">
      <div className="w-full max-w-sm bg-card text-card-foreground border rounded-xl shadow-sm">
        <div className="flex flex-col space-y-1.5 p-6">
          <h3 className="font-semibold tracking-tight text-2xl">{t('title')}</h3>
          <p className="text-sm text-muted-foreground">{t('description')}</p>
        </div>
        <div className="p-6 pt-0 space-y-4">
          <Link
            href="/api/auth/login/github"
            prefetch={false}
            className="w-full inline-flex items-center justify-center whitespace-nowrap rounded-md text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50 border border-input bg-background shadow-sm hover:bg-accent hover:text-accent-foreground h-9 px-4 py-2"
          >
            {t('continueWithGithub')}
          </Link>

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
