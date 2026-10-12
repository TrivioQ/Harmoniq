// Copyright The Harmoniq Authors
// SPDX-License-Identifier: Apache-2.0

import { getTranslations } from 'next-intl/server';
import type { WorkspaceStorageConfigResponse } from '@harmoniq/core/dist/schemas/WorkspaceStorageConfigSchema';
import { authedFetch } from '@/lib/registry';
import { StorageForm } from '@/components/StorageForm';
import { workspaceApi } from '@/lib/workspaceApi';
import { ActionForm } from '@/components/ActionForm';
import { deleteWorkspaceAction, transferWorkspaceAction } from '../../../lifecycleActions';

export default async function StorageSettingsPage(props: {
  params: Promise<{ workspaceSlug: string }>;
}) {
  const { workspaceSlug } = await props.params;
  const t = await getTranslations('SettingsPage');
  const [res, detail] = await Promise.all([
    authedFetch<{ storageConfig: WorkspaceStorageConfigResponse | null }>(
      `/api/workspaces/${encodeURIComponent(workspaceSlug)}/storage`
    ),
    workspaceApi.get(workspaceSlug),
  ]);
  // POL-09: what the organization imposes here, and where each value comes from.
  const policy = await workspaceApi.policy(workspaceSlug).catch(() => null);
  const imposed = policy?.organization
    ? [
        policy.retentionDays.minimum !== null &&
          t('policy.retention', {
            value: policy.retentionDays.value,
            minimum: policy.retentionDays.minimum,
          }),
        ...policy.approvals
          .filter((a) => a.locked && a.policy)
          .map((a) =>
            t('policy.approval', {
              environment: `${a.hostApp}/${a.environment}`,
              approvers: a.policy!.requiredApprovers,
              roles: a.policy!.eligibleRoles.join(', '),
            })
          ),
        ...policy.freezes.map((f) =>
          t('policy.freeze', { environment: `${f.hostApp}/${f.environment}`, reason: f.reason })
        ),
        policy.apiKeys.maxDays.value !== null &&
          t('policy.keyDays', { days: policy.apiKeys.maxDays.value }),
        policy.apiKeys.allowedScopes.value.length > 0 &&
          t('policy.keyScopes', { scopes: policy.apiKeys.allowedScopes.value.join(', ') }),
        policy.sso.locked && t('policy.sso'),
        policy.session.maxHours.value !== null &&
          t('policy.sessionMax', { hours: policy.session.maxHours.value }),
        policy.session.idleTimeoutMinutes.value !== null &&
          t('policy.idle', { minutes: policy.session.idleTimeoutMinutes.value }),
        policy.ipAllowlist.value.length > 0 &&
          t('policy.ip', { count: policy.ipAllowlist.value.length }),
      ].filter((line): line is string => !!line)
    : [];
  return (
    <>
      {imposed.length > 0 && (
        <section className="rounded-xl border bg-card p-6 space-y-2 max-w-2xl">
          <h3 className="font-semibold">
            <span aria-hidden="true">🔒 </span>
            {t('policy.title')}
          </h3>
          <p className="text-sm text-muted-foreground">{t('policy.hint')}</p>
          <ul className="text-sm list-disc pl-5 space-y-0.5">
            {imposed.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        </section>
      )}
      <section className="rounded-xl border bg-card p-6 space-y-4 max-w-2xl">
        <h3 className="font-semibold">{t('storage')}</h3>
        <StorageForm
          slug={workspaceSlug}
          initial={res.storageConfig}
          plan={{ allowed: detail.features?.byob ?? true, name: detail.plan ?? 'hobby' }}
        />
      </section>
      {/* TLC-07: everything in the workspace as JSON Lines (admins). */}
      {(detail.role === 'owner' || detail.role === 'admin' || detail.viaOrgAdmin) && (
        <section className="rounded-xl border bg-card p-6 space-y-2 max-w-2xl">
          <h3 className="font-semibold">{t('exportTitle')}</h3>
          <p className="text-sm text-muted-foreground">{t('exportHint')}</p>
          <a
            href={`/api/tenant-export?${new URLSearchParams({ scope: 'workspace', slug: workspaceSlug })}`}
            className="text-sm underline hover:text-primary"
            download
          >
            {t('exportDownload')}
          </a>
        </section>
      )}
      {/* TLC-01: owners delete the workspace; restorable for a while (TLC-02). */}
      {detail.role === 'owner' && (
        <section className="rounded-xl border border-red-200 bg-card p-6 space-y-3 max-w-2xl">
          <h3 className="font-semibold text-red-700">{t('dangerZone')}</h3>
          {/* TLC-06: hand the workspace to a member, who accepts. */}
          <p className="text-sm text-muted-foreground">{t('transferHint')}</p>
          <ActionForm
            action={transferWorkspaceAction.bind(null, workspaceSlug)}
            submitLabel={t('transfer')}
            variant="outline"
            className="flex flex-wrap gap-2"
          >
            <input
              name="email"
              type="email"
              required
              placeholder="new-owner@example.com"
              aria-label={t('transferTo')}
              className="rounded-md border px-3 py-1.5 text-sm"
            />
          </ActionForm>
          <p className="text-sm text-muted-foreground">{t('deleteHint')}</p>
          <ActionForm
            action={deleteWorkspaceAction.bind(null, workspaceSlug)}
            submitLabel={t('deleteWorkspace')}
            variant="danger"
            confirm={t('deleteConfirm', { workspace: workspaceSlug })}
            className="flex flex-wrap gap-2"
          >
            <input
              name="confirm"
              required
              placeholder={workspaceSlug}
              aria-label={t('typeSlug')}
              className="rounded-md border px-3 py-1.5 text-sm font-mono"
            />
          </ActionForm>
        </section>
      )}
    </>
  );
}
