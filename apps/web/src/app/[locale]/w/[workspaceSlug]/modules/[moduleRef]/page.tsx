import { notFound } from 'next/navigation';
import { getFormatter, getTranslations } from 'next-intl/server';
import { Link } from '@/i18n/routing';
import { ActionForm } from '@/components/ActionForm';
import { HealthSparkline } from '@/components/HealthSparkline';
import { RegistryError } from '@/lib/registry';
import { HealthStats, roleAtLeast, workspaceApi } from '@/lib/workspaceApi';
import {
  abortCanaryAction,
  advanceCanaryAction,
  promoteAction,
  promoteCanaryAction,
  rollbackAction,
  setCanaryAction,
  setKillSwitchAction,
  setModuleOwnersAction,
  setModuleSharedAction,
} from '../../actions';

const statusStyle: Record<string, string> = {
  active: 'bg-green-100 text-green-800',
  canary: 'bg-amber-100 text-amber-800',
  inactive: 'bg-muted text-muted-foreground',
};

export default async function ModuleDetailPage(props: {
  params: Promise<{ workspaceSlug: string; moduleRef: string }>;
  searchParams: Promise<{ env?: string }>;
}) {
  const { workspaceSlug, moduleRef } = await props.params;
  const { env: envParam } = await props.searchParams;
  const t = await getTranslations('ModuleDetail');
  const format = await getFormatter();

  const [module, workspace] = await Promise.all([
    workspaceApi.module(workspaceSlug, moduleRef).catch((err) => {
      if (err instanceof RegistryError && err.status === 404) notFound();
      throw err;
    }),
    workspaceApi.get(workspaceSlug),
  ]);
  const env = module.environments.find((e) => e.slug === envParam) ?? module.environments[0];
  if (!env) notFound();
  const [{ versions }, health] = await Promise.all([
    workspaceApi.versions(workspaceSlug, module.id, env.slug),
    workspaceApi.moduleHealth(workspaceSlug, module.id, env.slug),
  ]);
  const percent = (rate: number | null) =>
    rate === null ? '—' : format.number(rate, { style: 'percent', maximumFractionDigits: 1 });
  const ms = (value: number | null) => (value === null ? '—' : `${value} ms`);
  const statsRow = (label: string, s: HealthStats) => (
    <tr>
      <th scope="row" className="px-3 py-1.5 text-left font-medium">
        {label}
      </th>
      <td className="px-3 py-1.5">{percent(s.loadSuccessRate)}</td>
      <td className="px-3 py-1.5">{ms(s.p50LoadMs)}</td>
      <td className="px-3 py-1.5">{ms(s.p95LoadMs)}</td>
      <td className="px-3 py-1.5">{s.errorCount}</td>
      <td className="px-3 py-1.5">{s.sampleCount}</td>
    </tr>
  );
  const active = versions.find((v) => v.status === 'active');
  const canary = versions.find((v) => v.status === 'canary');

  // RBAC-02: the registry says whether you may change this module (owners, admins).
  const canDeploy = module.canWrite;
  const isAdmin = roleAtLeast(workspace.role, 'admin');
  const members = isAdmin ? (await workspaceApi.members(workspaceSlug)).members : [];
  // PRO-05: promotion is offered to admins and owners.
  const canPromote = roleAtLeast(workspace.role, 'admin') && !!active;
  const promoteTargets = module.environments.filter((e) => e.slug !== env.slug);
  const canManageCanary = canDeploy && !env.frozen;
  const percentInput = (defaultValue: number) => (
    <input
      type="number"
      name="trafficPercent"
      min={1}
      max={99}
      step={1}
      required
      defaultValue={defaultValue}
      aria-label={t('canaryTraffic')}
      className="w-20 rounded-md border px-2 py-1.5 text-sm"
    />
  );

  return (
    <div className="container p-6 md:p-10 max-w-6xl space-y-6">
      <div>
        <Link
          href={`/w/${workspaceSlug}/modules`}
          className="text-sm text-muted-foreground hover:underline"
        >
          ← {t('back')}
        </Link>
        <h2 className="text-3xl font-bold tracking-tight mt-2">{module.name}</h2>
        <p className="text-muted-foreground">
          {module.slug} · {module.hostApp.name}
        </p>
      </div>

      <nav className="flex gap-2 border-b" aria-label={t('environments')}>
        {module.environments.map((e) => (
          <Link
            key={e.slug}
            href={`/w/${workspaceSlug}/modules/${module.id}?env=${e.slug}`}
            className={`px-3 py-2 text-sm border-b-2 -mb-px ${e.slug === env.slug ? 'border-primary font-medium' : 'border-transparent text-muted-foreground'}`}
          >
            {e.name} {e.frozen && '🔒'}
          </Link>
        ))}
      </nav>

      {env.frozen && (
        <div className="rounded-md bg-blue-50 border border-blue-200 p-3 text-sm text-blue-900">
          🔒 {t('frozen', { reason: env.freezeReason ?? '' })}
        </div>
      )}

      {env.disabled ? (
        <section className="rounded-xl border border-red-300 bg-red-50 p-4 flex flex-wrap items-center justify-between gap-3">
          <p className="text-sm text-red-900">
            <strong>{t('killedTitle')}</strong> {env.disabled.reason}
          </p>
          {canDeploy && (
            <ActionForm
              action={setKillSwitchAction.bind(null, workspaceSlug, module.id, env.slug, false)}
              submitLabel={t('killEnable')}
              confirm={t('killEnableConfirm', { environment: env.name })}
              variant="outline"
            />
          )}
        </section>
      ) : (
        canDeploy && (
          <details className="rounded-xl border bg-card p-4">
            <summary className="cursor-pointer text-sm font-medium">{t('killTitle')}</summary>
            <p className="mt-2 text-sm text-muted-foreground">
              {t('killHint', { environment: env.name })}
            </p>
            <ActionForm
              action={setKillSwitchAction.bind(null, workspaceSlug, module.id, env.slug, true)}
              submitLabel={t('killDisable')}
              confirm={t('killDisableConfirm', { module: module.name, environment: env.name })}
              variant="danger"
              className="mt-3 flex flex-wrap items-center gap-2"
            >
              <input
                name="reason"
                required
                minLength={3}
                maxLength={500}
                placeholder={t('killReason')}
                aria-label={t('killReason')}
                className="w-80 rounded-md border px-3 py-1.5 text-sm"
              />
            </ActionForm>
          </details>
        )
      )}

      <section className="rounded-xl border bg-card p-4 space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="font-semibold">
            {t('healthTitle', { minutes: health.windowMinutes })}{' '}
            <span className="text-sm font-normal text-muted-foreground">
              {t(`trend.${health.trend}`)}
            </span>
          </h3>
          <HealthSparkline
            points={health.hourly}
            since={health.hourlySince}
            label={t('healthSparkline')}
          />
        </div>
        {health.sampleCount === 0 ? (
          <p className="text-sm text-muted-foreground">{t('healthNone')}</p>
        ) : (
          <>
            <table className="text-sm">
              <thead className="text-muted-foreground">
                <tr>
                  <th />
                  <th className="px-3 py-1 text-left font-normal">{t('healthSuccess')}</th>
                  <th className="px-3 py-1 text-left font-normal">p50</th>
                  <th className="px-3 py-1 text-left font-normal">p95</th>
                  <th className="px-3 py-1 text-left font-normal">{t('healthErrors')}</th>
                  <th className="px-3 py-1 text-left font-normal">{t('healthSamples')}</th>
                </tr>
              </thead>
              <tbody>
                {statsRow(t('statuses.active'), health.variants.stable)}
                {health.variants.canary.sampleCount > 0 &&
                  statsRow(t('statuses.canary'), health.variants.canary)}
              </tbody>
            </table>
            {health.topErrors.length > 0 && (
              <ul className="text-xs space-y-1">
                {health.topErrors.map((e) => (
                  <li key={`${e.variant}:${e.message}`} className="font-mono text-red-700">
                    {e.count}× [{t(`statuses.${e.variant === 'canary' ? 'canary' : 'active'}`)}]{' '}
                    {e.message}
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
      </section>

      <section className="rounded-xl border border-amber-200 bg-amber-50/50 p-4 space-y-3">
        <h3 className="font-semibold">{t('canaryTitle')}</h3>
        {canary ? (
          <>
            <p className="text-sm">
              {t('canaryRunning', {
                version: canary.version,
                percent: canary.trafficPercent ?? 0,
                active: active?.version ?? '—',
              })}
            </p>
            {!!canary.targeting?.length && (
              <p className="text-sm">
                {t('canaryTargeting')}{' '}
                {canary.targeting.map((rule, i) => (
                  <span key={rule.attribute}>
                    {i > 0 && ` ${t('canaryTargetingOr')} `}
                    <code className="rounded bg-muted px-1 text-xs">
                      {rule.attribute} ∈ {rule.values.join(', ')}
                    </code>
                  </span>
                ))}
              </p>
            )}
            {canary.rollout && (
              <div className="space-y-2">
                <ol
                  className="flex flex-wrap items-center gap-1 text-xs"
                  aria-label={t('rolloutTitle')}
                >
                  {canary.rollout.bands.map((band, i) => (
                    <li
                      key={band.percent}
                      className={`rounded px-2 py-0.5 ${
                        i < canary.rollout!.currentBandIndex
                          ? 'bg-amber-200 text-amber-900'
                          : i === canary.rollout!.currentBandIndex
                            ? 'bg-amber-500 text-white font-medium'
                            : 'bg-muted text-muted-foreground'
                      }`}
                    >
                      {band.percent}%
                    </li>
                  ))}
                </ol>
                <p className="text-sm text-muted-foreground">
                  {t('rolloutStatus', {
                    band: canary.rollout.currentBandIndex + 1,
                    bands: canary.rollout.bands.length,
                    next: format.dateTime(
                      new Date(
                        new Date(canary.rollout.bandStartedAt).getTime() +
                          canary.rollout.bands[canary.rollout.currentBandIndex].holdMinutes * 60_000
                      ),
                      { hour: '2-digit', minute: '2-digit' }
                    ),
                    samples: canary.rollout.gate.minSamples,
                  })}
                </p>
              </div>
            )}
            {canManageCanary && (
              <div className="flex flex-wrap items-start gap-3">
                {canary.rollout && (
                  <ActionForm
                    action={advanceCanaryAction.bind(null, workspaceSlug, module.id, env.slug)}
                    submitLabel={t('rolloutAdvance')}
                    confirm={t('rolloutAdvanceConfirm')}
                    variant="outline"
                  />
                )}
                <ActionForm
                  action={setCanaryAction.bind(null, workspaceSlug, module.id, env.slug, null)}
                  submitLabel={t('canaryUpdate')}
                  variant="outline"
                  className="flex items-center gap-2"
                >
                  {percentInput(canary.trafficPercent ?? 10)}
                </ActionForm>
                <ActionForm
                  action={promoteCanaryAction.bind(null, workspaceSlug, module.id, env.slug)}
                  submitLabel={t('canaryPromote')}
                  confirm={t('canaryPromoteConfirm', {
                    version: canary.version,
                    environment: env.name,
                  })}
                />
                <ActionForm
                  action={abortCanaryAction.bind(null, workspaceSlug, module.id, env.slug)}
                  submitLabel={t('canaryAbort')}
                  confirm={t('canaryAbortConfirm', {
                    version: canary.version,
                    active: active?.version ?? '—',
                  })}
                  variant="outline"
                />
              </div>
            )}
          </>
        ) : (
          <p className="text-sm text-muted-foreground">{t('canaryNone')}</p>
        )}
      </section>

      {(module.canShare || module.orgShared) && (
        <section className="rounded-xl border bg-card p-4 flex flex-wrap items-center justify-between gap-3">
          <p className="text-sm">{module.orgShared ? t('sharedOn') : t('sharedOff')}</p>
          {module.canShare && (
            <ActionForm
              action={setModuleSharedAction.bind(null, workspaceSlug, module.id, !module.orgShared)}
              submitLabel={module.orgShared ? t('unshare') : t('share')}
              variant="outline"
            />
          )}
        </section>
      )}

      <details className="rounded-xl border bg-card p-4" open={module.owners.length > 0}>
        <summary className="cursor-pointer text-sm font-medium">
          {t('ownersTitle')}:{' '}
          <span className="font-normal text-muted-foreground">
            {module.owners.length
              ? module.owners.map((o) => o.name ?? o.email).join(', ')
              : t('ownersNone')}
          </span>
        </summary>
        <p className="mt-2 text-sm text-muted-foreground">{t('ownersHint')}</p>
        {isAdmin && (
          <ActionForm
            action={setModuleOwnersAction.bind(null, workspaceSlug, module.id)}
            submitLabel={t('ownersSave')}
            variant="outline"
            className="mt-3 space-y-2"
          >
            <fieldset className="flex flex-wrap gap-x-4 gap-y-1 text-sm">
              <legend className="sr-only">{t('ownersTitle')}</legend>
              {members
                .filter((m) => m.status === 'active')
                .map((m) => (
                  <label key={m.id} className="flex items-center gap-1">
                    <input
                      type="checkbox"
                      name="owner"
                      value={m.id}
                      defaultChecked={module.owners.some((o) => o.memberId === m.id)}
                    />
                    {m.user.name ?? m.user.email}
                  </label>
                ))}
            </fieldset>
          </ActionForm>
        )}
      </details>

      {canPromote && promoteTargets.length > 0 && (
        <section className="rounded-xl border bg-card p-4">
          <ActionForm
            action={promoteAction.bind(null, workspaceSlug, module.id, env.slug)}
            submitLabel={t('promote', { version: active!.version })}
            confirm={t('promoteConfirm', { version: active!.version })}
            className="flex flex-wrap items-center gap-3"
          >
            <label className="text-sm" htmlFor="toEnvironment">
              {t('promoteTo')}
            </label>
            <select
              id="toEnvironment"
              name="toEnvironment"
              className="rounded-md border px-2 py-1.5 text-sm"
            >
              {promoteTargets.map((e) => (
                <option key={e.slug} value={e.slug}>
                  {e.name}
                </option>
              ))}
            </select>
          </ActionForm>
        </section>
      )}

      <div className="rounded-xl border bg-card overflow-hidden">
        <table className="min-w-full text-sm">
          <thead className="bg-muted/50 text-left">
            <tr>
              <th className="px-4 py-2 font-medium">{t('version')}</th>
              <th className="px-4 py-2 font-medium">{t('status')}</th>
              <th className="px-4 py-2 font-medium">{t('deployed')}</th>
              <th className="px-4 py-2 font-medium">{t('source')}</th>
              <th className="px-4 py-2" />
            </tr>
          </thead>
          <tbody className="divide-y">
            {versions.map((v) => (
              <tr key={v.id}>
                <td className="px-4 py-2">
                  <div className="font-mono">{v.version}</div>
                  <div className="text-xs text-muted-foreground truncate max-w-xs" title={v.url}>
                    {v.url}
                  </div>
                </td>
                <td className="px-4 py-2">
                  <span className={`rounded px-2 py-0.5 text-xs ${statusStyle[v.status] ?? ''}`}>
                    {t(`statuses.${v.status}`)}
                    {v.status === 'canary' && ` · ${v.trafficPercent}%`}
                  </span>
                </td>
                <td className="px-4 py-2 whitespace-nowrap">
                  <time dateTime={v.deployedAt}>{format.relativeTime(new Date(v.deployedAt))}</time>
                  <div className="text-xs text-muted-foreground">
                    {v.deployedByType === 'apiKey' ? t('byApiKey') : t('byUser')}
                  </div>
                </td>
                <td className="px-4 py-2 text-xs text-muted-foreground">
                  {v.promotedFromEnv && t('promotedFrom', { environment: v.promotedFromEnv })}
                  {v.approval &&
                    (v.approval.bypassed ? (
                      <div
                        className="font-medium text-red-700"
                        title={v.approval.bypassJustification ?? ''}
                      >
                        ⚠️ {t('bypassed')}
                      </div>
                    ) : (
                      <div>
                        {t('approvedBy', {
                          count: v.approval.decisions.filter((d) => d.decision === 'approved')
                            .length,
                        })}
                      </div>
                    ))}
                  {v.approval?.changeTicket && (
                    <div className="font-mono">{v.approval.changeTicket.id}</div>
                  )}
                  {v.commitSha && <div className="font-mono">{v.commitSha.slice(0, 7)}</div>}
                </td>
                <td className="px-4 py-2 text-right">
                  {canDeploy && v.status === 'inactive' && !env.frozen && (
                    <div className="inline-flex flex-wrap justify-end gap-2">
                      <ActionForm
                        action={rollbackAction.bind(null, workspaceSlug, module.id, env.slug, v.id)}
                        submitLabel={t('rollback')}
                        pendingLabel={t('rollingBack')}
                        confirm={t('rollbackConfirm', {
                          version: v.version,
                          environment: env.name,
                        })}
                        variant="outline"
                        className="inline-flex flex-col items-end gap-1"
                      />
                      {active && (
                        <ActionForm
                          action={setCanaryAction.bind(
                            null,
                            workspaceSlug,
                            module.id,
                            env.slug,
                            v.id
                          )}
                          submitLabel={t('canaryStart')}
                          confirm={t('canaryStartConfirm', {
                            version: v.version,
                            environment: env.name,
                          })}
                          variant="outline"
                          className="inline-flex items-center gap-2"
                        >
                          {percentInput(10)}
                        </ActionForm>
                      )}
                    </div>
                  )}
                </td>
              </tr>
            ))}
            {versions.length === 0 && (
              <tr>
                <td colSpan={5} className="px-4 py-6 text-center text-muted-foreground">
                  {t('noVersions')}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
