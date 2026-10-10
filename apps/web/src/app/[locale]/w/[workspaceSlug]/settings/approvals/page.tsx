// Copyright The Harmoniq Authors
// SPDX-License-Identifier: Apache-2.0

import { getTranslations } from 'next-intl/server';
import { ActionForm } from '@/components/ActionForm';
import { workspaceApi } from '@/lib/workspaceApi';
import { deleteApprovalPolicyAction, setApprovalPolicyAction } from '../../actions';

const ROLES = ['developer', 'admin', 'owner'] as const;
const input = 'rounded-md border px-2 py-1.5 text-sm';

/** APR-01/02/13: approval rules per environment. */
export default async function ApprovalRulesPage(props: {
  params: Promise<{ workspaceSlug: string }>;
}) {
  const { workspaceSlug } = await props.params;
  const t = await getTranslations('ApprovalRulesPage');
  const [workspace, { policies }] = await Promise.all([
    workspaceApi.get(workspaceSlug),
    workspaceApi.approvalPolicies(workspaceSlug),
  ]);

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">{t('description')}</p>
      {workspace.hostApps.flatMap((hostApp) =>
        hostApp.environments.map((env) => {
          const policy = policies.find(
            (p) => p.hostApp === hostApp.slug && p.environment === env.slug
          );
          return (
            <section
              key={`${hostApp.slug}/${env.slug}`}
              className="rounded-xl border bg-card p-4 space-y-3"
            >
              <div className="flex items-center justify-between gap-2">
                <h3 className="font-semibold">
                  {hostApp.name} / {env.name}
                </h3>
                {!policy && <span className="text-xs text-muted-foreground">{t('none')}</span>}
              </div>
              <ActionForm
                action={setApprovalPolicyAction.bind(null, workspaceSlug, hostApp.slug, env.slug)}
                submitLabel={t('save')}
                variant="outline"
                className="grid gap-3 sm:grid-cols-2 max-w-3xl"
              >
                <label className="text-sm space-y-1">
                  <span>{t('required')}</span>
                  <input
                    name="requiredApprovers"
                    type="number"
                    min={1}
                    max={10}
                    defaultValue={policy?.requiredApprovers ?? 1}
                    className={`${input} w-24 block`}
                  />
                </label>
                <fieldset className="text-sm space-y-1">
                  <legend>{t('roles')}</legend>
                  <div className="flex gap-3">
                    {ROLES.map((role) => (
                      <label key={role} className="flex items-center gap-1">
                        <input
                          type="checkbox"
                          name="eligibleRoles"
                          value={role}
                          defaultChecked={
                            policy ? policy.eligibleRoles.includes(role) : role !== 'developer'
                          }
                        />
                        {role}
                      </label>
                    ))}
                  </div>
                </fieldset>
                <label className="text-sm flex items-center gap-2">
                  <input
                    type="checkbox"
                    name="requireChangeTicket"
                    defaultChecked={policy?.requireChangeTicket ?? false}
                  />
                  {t('ticket')}
                </label>
                <label className="text-sm space-y-1">
                  <span>{t('expiry')}</span>
                  <input
                    name="expiryHours"
                    type="number"
                    min={1}
                    max={720}
                    defaultValue={policy?.expiryHours ?? 24}
                    className={`${input} w-24 block`}
                  />
                </label>
                <input
                  name="ticketUrlPattern"
                  type="url"
                  defaultValue={policy?.ticketUrlPattern ?? ''}
                  placeholder={t('ticketPattern')}
                  aria-label={t('ticketPattern')}
                  className={`${input} sm:col-span-2`}
                />
              </ActionForm>
              {policy && (
                <ActionForm
                  action={deleteApprovalPolicyAction.bind(
                    null,
                    workspaceSlug,
                    hostApp.slug,
                    env.slug
                  )}
                  submitLabel={t('remove')}
                  confirm={t('removeConfirm')}
                  variant="danger"
                />
              )}
            </section>
          );
        })
      )}
    </div>
  );
}
