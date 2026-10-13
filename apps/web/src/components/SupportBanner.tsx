// Copyright The Harmoniq Authors
// SPDX-License-Identifier: Apache-2.0

import { getFormatter, getTranslations } from 'next-intl/server';

export interface SupportAccessNotice {
  id: string;
  admin: string;
  reason: string;
  expiresAt: string;
}

/**
 * INST-20: shown to a tenant's admins while an instance admin has read-only support
 * access: who, why and until when.
 */
export async function SupportBanner({ grants }: { grants?: SupportAccessNotice[] }) {
  if (!grants?.length) return null;
  const t = await getTranslations('SupportBanner');
  const format = await getFormatter();
  return (
    <div role="status" className="bg-blue-50 text-blue-900 text-sm px-4 md:px-8 py-2 space-y-0.5">
      {grants.map((g) => (
        <p key={g.id}>
          {t('active', {
            admin: g.admin,
            until: format.dateTime(new Date(g.expiresAt), 'short'),
            reason: g.reason,
          })}
        </p>
      ))}
    </div>
  );
}
