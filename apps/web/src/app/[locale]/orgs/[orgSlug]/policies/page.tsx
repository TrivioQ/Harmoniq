// Copyright The Harmoniq Authors
// SPDX-License-Identifier: Apache-2.0

import { getFormatter, getTranslations } from 'next-intl/server';
import { Link } from '@/i18n/routing';
import { ActionForm } from '@/components/ActionForm';
import { type ApprovalDefault, type OrgFreezeWindow, orgApi } from '@/lib/orgApi';
import { type EffectivePolicy, workspaceApi } from '@/lib/workspaceApi';
import {
  endOrgFreezeOverrideAction,
  overrideOrgFreezeAction,
  saveOrgPolicyAction,
} from '../../actions';

const input = 'rounded-md border px-3 py-1.5 text-sm bg-background';
const ROLES = ['developer', 'admin', 'owner'] as const;
const SCOPES = ['manifest:read', 'deploy:write', 'admin'] as const;
/** Empty rows offered for new rules and windows. */
const SPARE_ROWS = 1;
/** Workspaces compared with the policy on this page (TAD-03). */
const COMPARED = 50;

const blankRule: ApprovalDefault = {
  environmentPattern: '',
  requiredApprovers: 1,
  eligibleRoles: ['admin', 'owner'],
  requireChangeTicket: false,
  ticketUrlPattern: null,
  expiryHours: 24,
};
const blankWindow: OrgFreezeWindow = {
  id: '',
  environmentPattern: '',
  from: null,
  until: null,
  reason: '',
  override: null,
};
/** An ISO time as a `datetime-local` value in UTC. */
const local = (iso: string | null) => (iso ? iso.slice(0, 16) : '');

/** TAD-03, POL-01..08: organization-wide policy (org admins edit, auditors read). */
export default async function OrgPoliciesPage(props: { params: Promise<{ orgSlug: string }> }) {
  const { orgSlug } = await props.params;
  const t = await getTranslations('OrgPolicies');
  const format = await getFormatter();
  const [policy, home] = await Promise.all([
    orgApi.policy(orgSlug),
    orgApi.home(orgSlug, { limit: String(COMPARED) }),
  ]);
  const admin = home.role === 'org_admin';
  // Which workspaces go further than the organization (admins reach every workspace).
  const live = home.workspaces.filter((w) => !w.deletedAt);
  const effective: Array<{ slug: string; name: string; policy: EffectivePolicy }> = admin
    ? (
        await Promise.all(
          live.map(async (w) => ({
            slug: w.slug,
            name: w.name,
            policy: await workspaceApi.policy(w.slug).catch(() => null),
          }))
        )
      ).filter((e): e is { slug: string; name: string; policy: EffectivePolicy } => !!e.policy)
    : [];
  const stricter = effective
    .map((e) => ({
      ...e,
      retention:
        policy.minRetentionDays !== null &&
        e.policy.retentionDays.workspace > policy.minRetentionDays
          ? e.policy.retentionDays.workspace
          : null,
      approvals: e.policy.approvals.filter((a) => a.locked && a.source === 'workspace'),
      ownApprovals: e.policy.approvals.filter((a) => !a.locked && a.source === 'workspace'),
      ownSso: e.policy.sso.ownConfigured && !e.policy.sso.locked,
    }))
    .filter((e) => e.retention || e.approvals.length || e.ownApprovals.length || e.ownSso);

  const rules = [...policy.approvalDefaults, ...Array(SPARE_ROWS).fill(blankRule)];
  const windows = [...policy.freezeWindows, ...Array(SPARE_ROWS).fill(blankWindow)];
  const activeWindows = policy.freezeWindows.filter(
    (w) =>
      (!w.from || new Date(w.from) <= new Date()) && (!w.until || new Date(w.until) > new Date())
  );

  const fields = (
    <fieldset disabled={!admin} className="space-y-6">
      {/* POL-02 */}
      <section className="rounded-xl border bg-card p-4 space-y-3">
        <h2 className="font-semibold text-sm">{t('approvals')}</h2>
        <p className="text-xs text-muted-foreground">{t('approvalsHint')}</p>
        <input type="hidden" name="ad_count" value={rules.length} />
        {rules.map((r, i) => (
          <div key={i} className="flex flex-wrap items-center gap-2 border-t pt-3 first:border-0">
            <input
              name={`ad_${i}_pattern`}
              defaultValue={r.environmentPattern}
              placeholder={i < policy.approvalDefaults.length ? '' : 'production'}
              pattern="[a-z0-9*\-]+"
              aria-label={t('pattern')}
              className={`${input} font-mono w-36`}
            />
            <label className="text-xs flex items-center gap-1">
              {t('approvers')}
              <input
                type="number"
                name={`ad_${i}_approvers`}
                min={1}
                max={10}
                defaultValue={r.requiredApprovers}
                className={`${input} w-16`}
              />
            </label>
            {ROLES.map((role) => (
              <label key={role} className="text-xs flex items-center gap-1">
                <input
                  type="checkbox"
                  name={`ad_${i}_roles`}
                  value={role}
                  defaultChecked={r.eligibleRoles.includes(role)}
                />
                {t(`role.${role}`)}
              </label>
            ))}
            <label className="text-xs flex items-center gap-1">
              <input
                type="checkbox"
                name={`ad_${i}_ticket`}
                defaultChecked={r.requireChangeTicket}
              />
              {t('changeTicket')}
            </label>
            <input
              name={`ad_${i}_ticketUrl`}
              defaultValue={r.ticketUrlPattern ?? ''}
              placeholder="https://jira.example.com/browse/{id}"
              aria-label={t('ticketUrl')}
              className={`${input} w-64`}
            />
            <label className="text-xs flex items-center gap-1">
              {t('expiryHours')}
              <input
                type="number"
                name={`ad_${i}_expiry`}
                min={1}
                max={720}
                defaultValue={r.expiryHours}
                className={`${input} w-20`}
              />
            </label>
          </div>
        ))}
        <p className="text-xs text-muted-foreground">{t('removeHint')}</p>
      </section>

      {/* POL-03, POL-04 */}
      <section className="rounded-xl border bg-card p-4 space-y-3">
        <h2 className="font-semibold text-sm">{t('keysAndRetention')}</h2>
        <div className="flex flex-wrap gap-4">
          <label className="text-xs flex flex-col gap-1">
            {t('maxApiKeyDays')}
            <input
              type="number"
              name="maxApiKeyDays"
              min={1}
              max={3650}
              defaultValue={policy.maxApiKeyDays ?? ''}
              placeholder={t('noLimit')}
              className={`${input} w-32`}
            />
          </label>
          <fieldset className="text-xs flex flex-col gap-1">
            <legend>{t('allowedKeyScopes')}</legend>
            <div className="flex gap-3">
              {SCOPES.map((scope) => (
                <label key={scope} className="flex items-center gap-1">
                  <input
                    type="checkbox"
                    name="allowedKeyScopes"
                    value={scope}
                    defaultChecked={policy.allowedKeyScopes.includes(scope)}
                  />
                  <code>{scope}</code>
                </label>
              ))}
            </div>
            <span className="text-muted-foreground">{t('allScopesHint')}</span>
          </fieldset>
          <label className="text-xs flex flex-col gap-1">
            {t('minRetentionDays')}
            <input
              type="number"
              name="minRetentionDays"
              min={1}
              max={3650}
              defaultValue={policy.minRetentionDays ?? ''}
              placeholder={t('noLimit')}
              className={`${input} w-32`}
            />
          </label>
        </div>
      </section>

      {/* POL-05 */}
      <section className="rounded-xl border bg-card p-4 space-y-3">
        <h2 className="font-semibold text-sm">{t('freezes')}</h2>
        <p className="text-xs text-muted-foreground">{t('freezesHint')}</p>
        <input type="hidden" name="fw_count" value={windows.length} />
        {windows.map((w, i) => (
          <div key={i} className="flex flex-wrap items-end gap-2 border-t pt-3 first:border-0">
            <input type="hidden" name={`fw_${i}_id`} value={w.id} />
            <input
              name={`fw_${i}_pattern`}
              defaultValue={w.environmentPattern}
              placeholder={w.id ? '' : 'prod*'}
              pattern="[a-z0-9*\-]+"
              aria-label={t('pattern')}
              className={`${input} font-mono w-36`}
            />
            <label className="text-xs flex flex-col gap-1">
              {t('fromUtc')}
              <input
                type="datetime-local"
                name={`fw_${i}_from`}
                defaultValue={local(w.from)}
                className={input}
              />
            </label>
            <label className="text-xs flex flex-col gap-1">
              {t('untilUtc')}
              <input
                type="datetime-local"
                name={`fw_${i}_until`}
                defaultValue={local(w.until)}
                className={input}
              />
            </label>
            <input
              name={`fw_${i}_reason`}
              defaultValue={w.reason}
              placeholder={t('reasonPlaceholder')}
              aria-label={t('reason')}
              className={`${input} flex-1 min-w-48`}
            />
          </div>
        ))}
      </section>

      {/* POL-06, POL-07 */}
      <section className="rounded-xl border bg-card p-4 space-y-3">
        <h2 className="font-semibold text-sm">{t('identity')}</h2>
        <label className="text-sm flex items-center gap-2">
          <input type="checkbox" name="lockSso" defaultChecked={policy.lockSso} />
          {t('lockSso')}
        </label>
        {/* SES-03 */}
        <label className="text-sm flex items-center gap-2">
          <input type="checkbox" name="requireMfa" defaultChecked={policy.requireMfa} />
          {t('requireMfa')}
        </label>
        <p className="text-xs text-muted-foreground">
          {t.rich('lockSsoHint', {
            link: (chunks) => (
              <Link href={`/orgs/${orgSlug}/sso`} className="underline">
                {chunks}
              </Link>
            ),
          })}
        </p>
        <div className="flex flex-wrap gap-4">
          <label className="text-xs flex flex-col gap-1">
            {t('sessionMaxHours')}
            <input
              type="number"
              name="sessionMaxHours"
              min={1}
              max={8760}
              defaultValue={policy.sessionMaxHours ?? ''}
              placeholder={t('noLimit')}
              className={`${input} w-32`}
            />
          </label>
          <label className="text-xs flex flex-col gap-1">
            {t('idleTimeoutMinutes')}
            <input
              type="number"
              name="idleTimeoutMinutes"
              min={5}
              max={43200}
              defaultValue={policy.idleTimeoutMinutes ?? ''}
              placeholder={t('noLimit')}
              className={`${input} w-32`}
            />
          </label>
        </div>
      </section>

      {/* POL-08 */}
      <section className="rounded-xl border bg-card p-4 space-y-3">
        <h2 className="font-semibold text-sm">{t('network')}</h2>
        <p className="text-xs text-muted-foreground">{t('networkHint')}</p>
        <textarea
          name="ipAllowlist"
          rows={4}
          defaultValue={policy.ipAllowlist.join('\n')}
          placeholder={'203.0.113.0/24\n2001:db8::/32'}
          aria-label={t('ipAllowlist')}
          className={`${input} w-full max-w-md font-mono`}
        />
        <label className="text-sm flex items-center gap-2">
          <input
            type="checkbox"
            name="ipAllowlistManifests"
            defaultChecked={policy.ipAllowlistManifests}
          />
          {t('ipAllowlistManifests')}
        </label>
      </section>
    </fieldset>
  );

  return (
    <>
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">{t('title')}</h1>
        <p className="text-sm text-muted-foreground">{t('description')}</p>
        {policy.updatedAt && (
          <p className="text-xs text-muted-foreground">
            {t('updated', { when: format.relativeTime(new Date(policy.updatedAt)) })}
          </p>
        )}
      </div>

      {admin ? (
        <ActionForm
          action={saveOrgPolicyAction.bind(null, orgSlug)}
          submitLabel={t('save')}
          className="space-y-6 max-w-4xl"
        >
          {fields}
        </ActionForm>
      ) : (
        <div className="space-y-6 max-w-4xl">{fields}</div>
      )}

      {/* POL-05: org admins let changes through an active window, recorded on each change. */}
      {activeWindows.length > 0 && (
        <section className="rounded-xl border border-blue-200 bg-card p-4 space-y-3 max-w-4xl">
          <h2 className="font-semibold text-sm">{t('activeFreezes')}</h2>
          {activeWindows.map((w) => (
            <div key={w.id} className="flex flex-wrap items-center justify-between gap-2 text-sm">
              <div>
                <span className="font-mono">{w.environmentPattern}</span> · {w.reason}
                {w.override && new Date(w.override.until) > new Date() && (
                  <div className="text-xs text-amber-800">
                    {t('overriddenUntil', {
                      when: format.dateTime(new Date(w.override.until), 'short'),
                      reason: w.override.reason,
                    })}
                  </div>
                )}
              </div>
              {admin &&
                (w.override && new Date(w.override.until) > new Date() ? (
                  <ActionForm
                    action={endOrgFreezeOverrideAction.bind(null, orgSlug, w.id)}
                    submitLabel={t('endOverride')}
                    variant="outline"
                  />
                ) : (
                  <ActionForm
                    action={overrideOrgFreezeAction.bind(null, orgSlug, w.id)}
                    submitLabel={t('override')}
                    confirm={t('overrideConfirm', { pattern: w.environmentPattern })}
                    variant="outline"
                    className="flex flex-wrap items-center gap-2"
                  >
                    <select
                      name="hours"
                      defaultValue="1"
                      aria-label={t('overrideFor')}
                      className={input}
                    >
                      {[1, 4, 24].map((h) => (
                        <option key={h} value={h}>
                          {t('hours', { hours: h })}
                        </option>
                      ))}
                    </select>
                    <input
                      name="reason"
                      required
                      placeholder={t('overrideReason')}
                      aria-label={t('reason')}
                      className={input}
                    />
                  </ActionForm>
                ))}
            </div>
          ))}
        </section>
      )}

      {/* TAD-03: where workspaces go further than the organization. */}
      {admin && (
        <section className="rounded-xl border bg-card p-4 space-y-2 max-w-4xl">
          <h2 className="font-semibold text-sm">{t('stricter')}</h2>
          {stricter.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t('noneStricter')}</p>
          ) : (
            <table className="w-full text-sm">
              <tbody>
                {stricter.map((e) => (
                  <tr key={e.slug} className="border-t first:border-0 align-top">
                    <td className="py-1.5 pr-3">
                      <Link
                        href={`/w/${e.slug}/settings`}
                        className="font-medium hover:text-primary"
                      >
                        {e.name}
                      </Link>
                    </td>
                    <td className="py-1.5 text-xs text-muted-foreground space-y-0.5">
                      {e.retention && <div>{t('stricterRetention', { days: e.retention })}</div>}
                      {e.approvals.map((a) => (
                        <div key={`${a.hostApp}/${a.environment}`}>
                          {t('stricterApprovals', {
                            environment: `${a.hostApp}/${a.environment}`,
                            approvers: a.policy?.requiredApprovers ?? 0,
                          })}
                        </div>
                      ))}
                      {e.ownApprovals.map((a) => (
                        <div key={`${a.hostApp}/${a.environment}`}>
                          {t('ownApprovals', { environment: `${a.hostApp}/${a.environment}` })}
                        </div>
                      ))}
                      {e.ownSso && <div>{t('ownSso')}</div>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {live.length >= COMPARED && (
            <p className="text-xs text-muted-foreground">
              {t('comparedFirst', { count: COMPARED })}
            </p>
          )}
        </section>
      )}
    </>
  );
}
