import { getFormatter, getTranslations } from 'next-intl/server';
import { Link } from '@/i18n/routing';
import { ActionForm } from '@/components/ActionForm';
import { roleAtLeast, workspaceApi } from '@/lib/workspaceApi';
import { freezeAction, unfreezeAction } from '../actions';

export default async function EnvironmentsPage(props: {
  params: Promise<{ workspaceSlug: string }>;
}) {
  const { workspaceSlug } = await props.params;
  const t = await getTranslations('EnvironmentsPage');
  const format = await getFormatter();
  const workspace = await workspaceApi.get(workspaceSlug);
  const isAdmin = roleAtLeast(workspace.role, 'admin');

  return (
    <div className="container p-6 md:p-10 max-w-6xl space-y-8">
      <div>
        <h2 className="text-3xl font-bold tracking-tight">{t('title')}</h2>
        <p className="text-muted-foreground mt-2">{t('description')}</p>
      </div>

      {workspace.hostApps.map((hostApp) => (
        <section key={hostApp.slug} className="space-y-3">
          <h3 className="font-semibold">
            {t('hostApp', { hostAppName: hostApp.name })}
            {hostApp.isDefault && (
              <span className="ml-2 bg-primary text-primary-foreground text-xs px-2 py-0.5 rounded">
                {t('default')}
              </span>
            )}
          </h3>
          <div className="grid gap-3">
            {hostApp.environments.map((env) => (
              <div key={env.slug} className="rounded-xl border bg-card shadow-sm p-5 space-y-3">
                <div className="flex justify-between items-center gap-4">
                  <div>
                    <h4 className="font-medium">
                      {env.name}
                      {env.frozen && (
                        <span className="ml-2 rounded bg-blue-100 text-blue-900 text-xs px-2 py-0.5 font-semibold">
                          🔒 {t('frozenBadge')}
                        </span>
                      )}
                    </h4>
                    <p className="text-sm text-muted-foreground font-mono">
                      /api/manifest/{workspaceSlug}/{hostApp.slug}/{env.slug}
                    </p>
                  </div>
                  <Link
                    href={`/${workspaceSlug}/environments/${hostApp.slug}/${env.slug}`}
                    className="text-sm text-primary hover:underline"
                  >
                    {t('history')}
                  </Link>
                </div>

                {env.frozen && (
                  <p className="text-sm text-blue-900">
                    {t('frozenReason', { reason: env.freezeReason ?? '' })}
                    {env.freezeUntil &&
                      ` · ${t('frozenUntil', { until: format.dateTime(new Date(env.freezeUntil), { dateStyle: 'medium', timeStyle: 'short' }) })}`}
                  </p>
                )}

                {isAdmin &&
                  (env.frozen ? (
                    <ActionForm
                      action={unfreezeAction.bind(null, workspaceSlug, hostApp.slug, env.slug)}
                      submitLabel={t('unfreeze')}
                      variant="outline"
                    />
                  ) : (
                    <ActionForm
                      action={freezeAction.bind(null, workspaceSlug, hostApp.slug, env.slug)}
                      submitLabel={t('freeze')}
                      variant="outline"
                      className="flex flex-wrap items-center gap-2"
                    >
                      <input
                        name="reason"
                        required
                        minLength={3}
                        placeholder={t('reasonPlaceholder')}
                        aria-label={t('reason')}
                        className="rounded-md border px-2 py-1.5 text-sm w-64"
                      />
                      <input
                        name="until"
                        type="datetime-local"
                        aria-label={t('until')}
                        className="rounded-md border px-2 py-1.5 text-sm"
                      />
                    </ActionForm>
                  ))}
              </div>
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}
