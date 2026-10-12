// Copyright The Harmoniq Authors
// SPDX-License-Identifier: Apache-2.0

import { getTranslations } from 'next-intl/server';
import { Link } from '@/i18n/routing';
import type { ChainReport } from '@/lib/orgApi';

/**
 * AUD-09: a link that checks the audit hash chain, and its result once asked for
 * (`?verify=1`). Each scope (organization, workspace, instance) has its own chain.
 */
export async function ChainCheck(props: {
  href: string;
  reports: Array<ChainReport & { label: string }> | null;
}) {
  const t = await getTranslations('ChainCheck');
  if (!props.reports) {
    return (
      <Link href={props.href} className="text-sm underline hover:text-primary">
        {t('verify')}
      </Link>
    );
  }
  const ok = props.reports.every((r) => r.ok);
  return (
    <section
      role="status"
      className={`rounded-md border p-3 text-sm ${ok ? 'border-green-200 bg-green-50 text-green-900' : 'border-red-200 bg-red-50 text-red-900'}`}
    >
      <p className="font-medium">{ok ? t('intact') : t('broken')}</p>
      <ul className="mt-1 space-y-0.5 text-xs">
        {props.reports.map((r) => (
          <li key={r.label}>
            {r.label}:{' '}
            {r.problem
              ? t('problem', {
                  kind: t(`kind.${r.problem.kind}`),
                  seq: r.problem.chainSeq,
                  id: r.problem.id,
                })
              : t('ok', { rows: r.rows })}
            {r.head && (
              <span className="block font-mono break-all text-muted-foreground">
                {t('head', { seq: r.head.chainSeq, hash: r.head.hash })}
              </span>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
