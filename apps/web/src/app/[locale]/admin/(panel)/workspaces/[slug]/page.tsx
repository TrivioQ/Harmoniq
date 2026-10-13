// Copyright The Harmoniq Authors
// SPDX-License-Identifier: Apache-2.0

import { notFound } from 'next/navigation';
import { getFormatter, getTranslations } from 'next-intl/server';
import { ActionForm } from '@/components/ActionForm';
import { QuotaBars } from '@/components/UsageMeters';
import { Link } from '@/i18n/routing';
import { adminApi } from '@/lib/adminApi';
import { RegistryError } from '@/lib/registry';
import {
  deleteWorkspaceAction,
  restoreWorkspaceAction,
  suspendWorkspaceAction,
  unsuspendWorkspaceAction,
} from '../../actions';
import { PlanForm } from '../../PlanForm';
import { SupportAccessPanel } from '../../SupportAccessPanel';

const card = 'bg-white p-4 rounded-lg shadow-sm border border-gray-100 space-y-2';
const small = 'rounded-md border px-2 py-1 text-xs';

/** INST-29: one workspace, for support and operations. */
export default async function AdminWorkspacePage(props: { params: Promise<{ slug: string }> }) {
  const { slug } = await props.params;
  const t = await getTranslations('AdminWorkspacePage');
  const format = await getFormatter();
  const ws = await adminApi.workspace(slug).catch((err) => {
    if (err instanceof RegistryError && err.status === 404) notFound();
    throw err;
  });
  const when = (d: string | null) => (d ? format.dateTime(new Date(d), 'short') : '—');

  return (
    <div className="space-y-6 max-w-5xl">
      <Link href="/admin/workspaces" className="text-sm text-indigo-700 hover:underline">
        ← {t('back')}
      </Link>
      <div>
        <h1 className="text-2xl font-bold text-gray-900">{ws.name}</h1>
        <p className="text-sm text-gray-500">
          {ws.slug}
          {ws.organization && (
            <>
              {' · '}
              <Link href={`/admin/orgs/${ws.organization.slug}`} className="text-indigo-700">
                {ws.organization.name}
              </Link>
            </>
          )}
          {' · '}
          {t('created', { date: when(ws.createdAt) })}
        </p>
        {ws.deletedAt ? (
          <p className="text-sm text-red-700">{t('deleted', { date: when(ws.purgeAfter) })}</p>
        ) : ws.suspendedAt ? (
          <p className="text-sm text-red-700">
            {t('suspended')}
            {ws.suspendedReason && `: ${ws.suspendedReason}`}
          </p>
        ) : null}
      </div>

      <div className="flex flex-wrap gap-2">
        {ws.deletedAt ? (
          <ActionForm
            action={restoreWorkspaceAction.bind(null, ws.slug)}
            submitLabel={t('restore')}
            variant="outline"
          />
        ) : ws.suspendedAt ? (
          <ActionForm
            action={unsuspendWorkspaceAction.bind(null, ws.slug)}
            submitLabel={t('unsuspend')}
            variant="outline"
          />
        ) : (
          <ActionForm
            action={suspendWorkspaceAction.bind(null, ws.slug)}
            submitLabel={t('suspend')}
            variant="outline"
            confirm={t('suspendConfirm', { slug: ws.slug })}
            className="flex gap-2 items-start"
          >
            <input
              name="reason"
              placeholder={t('reason')}
              aria-label={t('reason')}
              className={small}
            />
          </ActionForm>
        )}
        <Link
          href={`/admin/workspaces/${ws.slug}/storage`}
          className="rounded-md border px-3 py-1.5 text-sm bg-white"
        >
          {t('storageSettings')}
        </Link>
      </div>

      <SupportAccessPanel target={{ kind: 'workspace', slug: ws.slug }} grants={ws.supportAccess} />

      <div className="grid gap-4 md:grid-cols-2">
        <section className={card}>
          <h2 className="text-sm font-medium text-gray-700">{t('plan')}</h2>
          <PlanForm
            target={{ kind: 'workspace', slug: ws.slug }}
            plan={ws.plan.plan}
            expiresAt={ws.plan.expiresAt}
            basePlan={ws.plan.basePlan}
            overrides={ws.plan.overrides}
          />
          {ws.plan.effective !== ws.plan.plan && (
            <p className="text-xs text-gray-500">
              {t('effectivePlan', { plan: ws.plan.effective })}
            </p>
          )}
          {ws.usage && <QuotaBars usage={ws.usage} />}
        </section>
        <section className={card}>
          <h2 className="text-sm font-medium text-gray-700">{t('access')}</h2>
          <dl className="grid grid-cols-2 gap-1 text-xs">
            <dt className="text-gray-500">{t('apiKeys')}</dt>
            <dd>
              {t('keysLine', { count: ws.apiKeys.active, date: when(ws.apiKeys.lastUsedAt) })}
            </dd>
            <dt className="text-gray-500">{t('sso')}</dt>
            <dd>
              {ws.sso.from
                ? t(ws.sso.from === 'workspace' ? 'ssoOwn' : 'ssoOrg', {
                    protocols: [ws.sso.own.oidc && 'OIDC', ws.sso.own.saml && 'SAML']
                      .filter(Boolean)
                      .join(', '),
                  })
                : t('ssoNone')}
              {ws.sso.forceSso && ` · ${t('forceSso')}`}
            </dd>
            <dt className="text-gray-500">{t('scim')}</dt>
            <dd>{ws.sso.scim ? t('on') : t('off')}</dd>
            <dt className="text-gray-500">{t('storage')}</dt>
            <dd>
              {ws.storage
                ? `${ws.storage.provider} · ${ws.storage.bucket} (${t('verified', { date: when(ws.storage.lastVerifiedAt) })})`
                : t('instanceStorage')}
            </dd>
            <dt className="text-gray-500">{t('retention')}</dt>
            <dd>{t('retentionDays', { days: ws.retentionDays })}</dd>
          </dl>
        </section>
      </div>

      <section className={card}>
        <h2 className="text-sm font-medium text-gray-700">{t('members')}</h2>
        <table className="w-full text-xs">
          <tbody>
            {ws.members.map((m) => (
              <tr key={m.userId} className="border-t">
                <td className="py-1">
                  <Link
                    href={`/admin/users/${m.userId}`}
                    className="text-indigo-700 hover:underline"
                  >
                    {m.email}
                  </Link>
                </td>
                <td className="py-1">{m.role}</td>
                <td className="py-1 text-gray-500">
                  {m.joinedAt ? t('lastLogin', { date: when(m.lastLoginAt) }) : t('invited')}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section className={card}>
        <h2 className="text-sm font-medium text-gray-700">{t('environments')}</h2>
        <table className="w-full text-xs">
          <tbody>
            {ws.hostApps.flatMap((h) =>
              h.environments.map((e) => (
                <tr key={`${h.slug}/${e.slug}`} className="border-t align-top">
                  <td className="py-1 font-mono">
                    {h.slug}/{e.slug}
                    {e.frozen && <span className="ml-2 text-amber-700">{t('frozen')}</span>}
                  </td>
                  <td className="py-1">{t('published', { date: when(e.lastPublishedAt) })}</td>
                  <td className="py-1 text-red-700 break-all">{e.lastPublishError ?? ''}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </section>

      <section className={card}>
        <div className="flex items-baseline justify-between">
          <h2 className="text-sm font-medium text-gray-700">{t('recentAudit')}</h2>
        </div>
        <table className="w-full text-xs">
          <tbody>
            {ws.recentAudit.map((e) => (
              <tr key={e.id} className="border-t">
                <td className="py-1 whitespace-nowrap text-gray-500">{when(e.createdAt)}</td>
                <td className="py-1 font-mono">{e.action}</td>
                <td className="py-1">{e.actor.label}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      {!ws.deletedAt && (
        <section className="rounded-lg border border-red-200 bg-red-50 p-4 space-y-2">
          <h2 className="text-sm font-medium text-red-800">{t('dangerZone')}</h2>
          <ActionForm
            action={deleteWorkspaceAction.bind(null, ws.slug)}
            submitLabel={t('delete')}
            variant="danger"
            confirm={t('deleteConfirm', { slug: ws.slug })}
            className="flex gap-2 items-start"
          >
            <input
              name="confirm"
              required
              placeholder={ws.slug}
              aria-label={t('typeSlug')}
              className={small}
            />
          </ActionForm>
        </section>
      )}
    </div>
  );
}
