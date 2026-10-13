// Copyright The Harmoniq Authors
// SPDX-License-Identifier: Apache-2.0

import { getTranslations } from 'next-intl/server';

// AUD-07/08: the parts every audit page (workspace, organization, instance) shares.

export interface AuditQuery {
  actor?: string;
  action?: string;
  from?: string;
  to?: string;
  workspace?: string;
  /** INST-36: instance log only. */
  resourceType?: string;
  cursor?: string;
}

/** Dates from the filter form (`YYYY-MM-DD`) as the API's range: `to` includes that day. */
export function auditRange(query: AuditQuery) {
  return {
    from: query.from || undefined,
    to: query.to ? `${query.to}T23:59:59.999Z` : undefined,
  };
}

/** The query string for a page of the log, with only the set values. */
export function auditHref(base: string, query: AuditQuery) {
  const qs = new URLSearchParams(
    Object.entries(query).filter((e): e is [string, string] => !!e[1])
  );
  return qs.size ? `${base}?${qs}` : base;
}

const input = 'rounded-md border px-3 py-1.5 text-sm bg-background';

/** Actor (email or id), action, date range and, in an organization, workspace. */
export async function AuditFilters(props: {
  query: AuditQuery;
  actionPlaceholder?: string;
  workspaces?: Array<{ slug: string; name: string }>;
  /** Show the resource type filter (INST-36). */
  resourceType?: boolean;
}) {
  const t = await getTranslations('AuditView');
  const q = props.query;
  return (
    <form className="flex flex-wrap items-end gap-2" method="get" aria-label={t('filters')}>
      {props.workspaces && (
        <select
          name="workspace"
          defaultValue={q.workspace ?? ''}
          className={input}
          aria-label={t('workspace')}
        >
          <option value="">{t('allWorkspaces')}</option>
          {props.workspaces.map((w) => (
            <option key={w.slug} value={w.slug}>
              {w.name}
            </option>
          ))}
        </select>
      )}
      <input
        name="actor"
        type="search"
        defaultValue={q.actor}
        placeholder={t('actorPlaceholder')}
        aria-label={t('actor')}
        className={input}
      />
      <input
        name="action"
        defaultValue={q.action}
        placeholder={props.actionPlaceholder ?? 'module.'}
        aria-label={t('action')}
        className={`${input} font-mono`}
      />
      {props.resourceType && (
        <input
          name="resourceType"
          defaultValue={q.resourceType}
          placeholder={t('resourceTypePlaceholder')}
          aria-label={t('resourceType')}
          className={`${input} font-mono`}
        />
      )}
      <label className="text-xs text-muted-foreground flex flex-col">
        {t('from')}
        <input name="from" type="date" defaultValue={q.from} className={input} />
      </label>
      <label className="text-xs text-muted-foreground flex flex-col">
        {t('to')}
        <input name="to" type="date" defaultValue={q.to} className={input} />
      </label>
      <button type="submit" className="rounded-md border px-3 py-1.5 text-sm hover:bg-muted">
        {t('apply')}
      </button>
    </form>
  );
}

/** Who did it: an email, a key's name and prefix, or a pseudonym for an erased user. */
export function AuditActorLabel(props: {
  actor?: { type: string; id: string; label: string; deleted: boolean };
  actorType: string;
  actorId: string;
}) {
  const label = props.actor?.label ?? `${props.actorType}:${props.actorId}`;
  return (
    <span
      title={props.actorId}
      className={props.actor?.deleted ? 'italic text-muted-foreground' : undefined}
    >
      {label}
    </span>
  );
}

/** The event's metadata, formatted, behind a disclosure. */
export async function AuditMetadata(props: {
  metadata: Record<string, unknown> | null;
  resource?: string;
}) {
  if (!props.metadata && !props.resource) return null;
  const t = await getTranslations('AuditView');
  return (
    <details className="text-xs">
      <summary className="cursor-pointer text-muted-foreground">{t('details')}</summary>
      {props.resource && <p className="mt-1 font-mono break-all">{props.resource}</p>}
      {props.metadata && (
        <pre className="mt-1 max-w-xl overflow-x-auto rounded bg-muted p-2 whitespace-pre-wrap break-all">
          {JSON.stringify(props.metadata, null, 2)}
        </pre>
      )}
    </details>
  );
}
