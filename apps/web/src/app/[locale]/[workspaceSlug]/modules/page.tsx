import { getTranslations } from 'next-intl/server';
import { Link } from '@/i18n/routing';
import { ActionForm } from '@/components/ActionForm';
import { roleAtLeast, workspaceApi } from '@/lib/workspaceApi';
import { createModuleAction } from '../actions';

const input = 'block w-full rounded-md border px-3 py-1.5 text-sm';

export default async function ModulesPage(props: { params: Promise<{ workspaceSlug: string }> }) {
  const { workspaceSlug } = await props.params;
  const t = await getTranslations('ModulesPage');
  const [{ modules }, workspace] = await Promise.all([
    workspaceApi.modules(workspaceSlug),
    workspaceApi.get(workspaceSlug),
  ]);

  return (
    <div className="container p-6 md:p-10 max-w-6xl space-y-8">
      <div>
        <h2 className="text-3xl font-bold tracking-tight">{t('title')}</h2>
        <p className="text-muted-foreground mt-2">{t('description')}</p>
      </div>

      <div className="grid gap-4">
        {modules.map((module) => (
          <Link
            key={module.id}
            href={`/${workspaceSlug}/modules/${module.id}`}
            className="rounded-xl border bg-card text-card-foreground shadow-sm p-6 hover:border-primary transition-colors"
          >
            <div className="flex justify-between items-start gap-4">
              <div>
                <h3 className="font-semibold">{module.name}</h3>
                <p className="text-sm text-muted-foreground">
                  {module.slug} · {t('hostedOn', { hostAppName: module.hostApp.name })}
                </p>
              </div>
              <dl className="flex gap-6 text-sm">
                {module.environments.map((env) => (
                  <div key={env.slug} className="text-right">
                    <dt className="text-muted-foreground">
                      {env.name} {env.frozen && '🔒'}
                    </dt>
                    <dd className="font-mono">{env.active?.version ?? '—'}</dd>
                    {env.canary && (
                      <dd className="text-xs text-amber-700">
                        {t('canaryBadge', {
                          version: env.canary.version,
                          percent: env.canary.trafficPercent ?? 0,
                        })}
                      </dd>
                    )}
                  </div>
                ))}
              </dl>
            </div>
          </Link>
        ))}
        {modules.length === 0 && (
          <div className="p-8 border border-dashed rounded-xl text-center">
            <p className="text-muted-foreground">{t('noModules')}</p>
          </div>
        )}
      </div>

      {roleAtLeast(workspace.role, 'admin') && (
        <section className="rounded-xl border bg-card p-6 space-y-3 max-w-xl">
          <h3 className="font-semibold">{t('addModule')}</h3>
          <ActionForm
            action={createModuleAction.bind(null, workspaceSlug)}
            submitLabel={t('create')}
          >
            <select name="hostApp" className={input} aria-label={t('hostApp')}>
              {workspace.hostApps.map((h) => (
                <option key={h.slug} value={h.slug}>
                  {h.name}
                </option>
              ))}
            </select>
            <input
              name="name"
              required
              placeholder={t('namePlaceholder')}
              className={input}
              aria-label={t('name')}
            />
            <input
              name="slug"
              required
              pattern="[a-z0-9]([a-z0-9-]*[a-z0-9])?"
              placeholder="checkout"
              className={input}
              aria-label={t('slug')}
            />
          </ActionForm>
        </section>
      )}
    </div>
  );
}
