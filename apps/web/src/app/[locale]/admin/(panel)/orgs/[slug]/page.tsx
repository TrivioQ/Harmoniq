// Copyright The Harmoniq Authors
// SPDX-License-Identifier: Apache-2.0

import { notFound } from 'next/navigation';
import { getFormatter, getTranslations } from 'next-intl/server';
import { ActionForm } from '@/components/ActionForm';
import { Link } from '@/i18n/routing';
import { adminApi } from '@/lib/adminApi';
import { RegistryError } from '@/lib/registry';
import {
  deleteOrgAction,
  restoreOrgAction,
  suspendOrgAction,
  unsuspendOrgAction,
} from '../../actions';
import { PlanForm } from '../../PlanForm';
import { SupportAccessPanel } from '../../SupportAccessPanel';

const card = 'bg-white p-4 rounded-lg shadow-sm border border-gray-100 space-y-2';
const small = 'rounded-md border px-2 py-1 text-xs';

/** INST-19: one organization: workspaces, members, plan, usage, SSO and domains. */
export default async function AdminOrgPage(props: { params: Promise<{ slug: string }> }) {
  const { slug } = await props.params;
  const t = await getTranslations('AdminOrgPage');
  const format = await getFormatter();
  const o = await adminApi.org(slug).catch((err) => {
    if (err instanceof RegistryError && err.status === 404) notFound();
    throw err;
  });
  const when = (d: string | null) => (d ? format.dateTime(new Date(d), 'short') : '—');

  return (
    <div className="space-y-6 max-w-5xl">
      <Link href="/admin/orgs" className="text-sm text-indigo-700 hover:underline">
        ← {t('back')}
      </Link>
      <div>
        <h1 className="text-2xl font-bold text-gray-900">{o.name}</h1>
        <p className="text-sm text-gray-500">
          {o.slug} · {t('created', { date: when(o.createdAt) })}
        </p>
        {o.deletedAt ? (
          <p className="text-sm text-red-700">{t('deleted', { date: when(o.purgeAfter) })}</p>
        ) : o.suspendedAt ? (
          <p className="text-sm text-red-700">
            {t('suspended')}
            {o.suspendedReason && `: ${o.suspendedReason}`}
          </p>
        ) : null}
      </div>

      <div className="flex flex-wrap gap-2 items-start">
        {o.deletedAt ? (
          <ActionForm
            action={restoreOrgAction.bind(null, o.slug)}
            submitLabel={t('restore')}
            variant="outline"
          />
        ) : o.suspendedAt ? (
          <ActionForm
            action={unsuspendOrgAction.bind(null, o.slug)}
            submitLabel={t('unsuspend')}
            variant="outline"
          />
        ) : (
          <ActionForm
            action={suspendOrgAction.bind(null, o.slug)}
            submitLabel={t('suspend')}
            variant="outline"
            confirm={t('suspendConfirm', { slug: o.slug })}
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
      </div>

      {!o.deletedAt && (
        <SupportAccessPanel
          target={{ kind: 'organization', slug: o.slug }}
          grants={o.supportAccess}
        />
      )}

      <div className="grid gap-4 md:grid-cols-2">
        <section className={card}>
          <h2 className="text-sm font-medium text-gray-700">{t('plan')}</h2>
          <PlanForm
            target={{ kind: 'org', slug: o.slug }}
            plan={o.plan.plan}
            expiresAt={o.plan.expiresAt}
            basePlan={o.plan.basePlan}
            overrides={o.plan.overrides}
          />
          <p className="text-xs text-gray-600">
            {t('usage', {
              deploys: o.usage.period.deploys,
              requests: o.usage.period.manifestRequests,
            })}
          </p>
        </section>
        <section className={card}>
          <h2 className="text-sm font-medium text-gray-700">{t('sso')}</h2>
          <p className="text-xs">
            {[o.sso.oidc && 'OIDC', o.sso.saml && 'SAML'].filter(Boolean).join(', ') ||
              t('ssoNone')}
            {o.sso.forceSso && ` · ${t('forceSso')}`}
            {` · SCIM ${o.sso.scim ? t('on') : t('off')}`}
          </p>
          <h3 className="text-xs font-medium text-gray-700 pt-2">{t('domains')}</h3>
          {o.domains.length === 0 ? (
            <p className="text-xs text-gray-500">{t('none')}</p>
          ) : (
            <ul className="text-xs space-y-1">
              {o.domains.map((d) => (
                <li key={d.domain}>
                  <span className="font-mono">{d.domain}</span>{' '}
                  {d.failingSince ? (
                    <span className="text-red-700">
                      {t('domainFailing', { date: when(d.failingSince) })}
                    </span>
                  ) : d.verifiedAt ? (
                    <span className="text-green-700">{t('domainVerified')}</span>
                  ) : (
                    <span className="text-gray-500">{t('domainPending')}</span>
                  )}
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>

      <section className={card}>
        <h2 className="text-sm font-medium text-gray-700">{t('workspaces')}</h2>
        {o.workspaces.length === 0 ? (
          <p className="text-xs text-gray-500">{t('none')}</p>
        ) : (
          <table className="w-full text-xs">
            <tbody>
              {o.workspaces.map((w) => (
                <tr key={w.slug} className="border-t">
                  <td className="py-1">
                    <Link
                      href={`/admin/workspaces/${w.slug}`}
                      className="text-indigo-700 hover:underline"
                    >
                      {w.name}
                    </Link>
                  </td>
                  <td className="py-1">
                    {t('workspaceLine', { members: w.members, modules: w.modules })}
                  </td>
                  <td className="py-1 text-red-700">
                    {w.deletedAt ? t('workspaceDeleted') : w.suspended ? t('suspended') : ''}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section className={card}>
        <h2 className="text-sm font-medium text-gray-700">{t('members')}</h2>
        <table className="w-full text-xs">
          <tbody>
            {o.members.map((m) => (
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
                <td className="py-1 text-gray-500">{when(m.lastLoginAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section className={card}>
        <h2 className="text-sm font-medium text-gray-700">{t('recentAudit')}</h2>
        <table className="w-full text-xs">
          <tbody>
            {o.recentAudit.map((e) => (
              <tr key={e.id} className="border-t">
                <td className="py-1 whitespace-nowrap text-gray-500">{when(e.createdAt)}</td>
                <td className="py-1 font-mono">{e.action}</td>
                <td className="py-1">{e.actor.label}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      {!o.deletedAt && (
        <section className="rounded-lg border border-red-200 bg-red-50 p-4 space-y-2">
          <h2 className="text-sm font-medium text-red-800">{t('dangerZone')}</h2>
          <p className="text-xs text-red-800">{t('deleteHint')}</p>
          <ActionForm
            action={deleteOrgAction.bind(null, o.slug)}
            submitLabel={t('delete')}
            variant="danger"
            confirm={t('deleteConfirm', { slug: o.slug })}
            className="flex gap-2 items-start"
          >
            <input
              name="confirm"
              required
              placeholder={o.slug}
              aria-label={t('typeSlug')}
              className={small}
            />
          </ActionForm>
        </section>
      )}
    </div>
  );
}
