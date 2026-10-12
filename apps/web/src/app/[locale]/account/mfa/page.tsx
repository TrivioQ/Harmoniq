// Copyright The Harmoniq Authors
// SPDX-License-Identifier: Apache-2.0

import { cookies } from 'next/headers';
import { getTranslations } from 'next-intl/server';
import QRCode from 'qrcode';
import { Link } from '@/i18n/routing';
import { ActionForm } from '@/components/ActionForm';
import { MFA_SETUP_COOKIE } from '@/lib/session';
import { enableMfaAction } from '../actions';

/** SES-03: scan the QR code (or type the key), then confirm with a code. */
export default async function MfaSetupPage() {
  const t = await getTranslations('AccountPage');
  const raw = (await cookies()).get(MFA_SETUP_COOKIE)?.value;
  let setup: { secret: string; otpauthUrl: string } | null = null;
  try {
    setup = raw ? JSON.parse(raw) : null;
  } catch {
    setup = null;
  }
  if (!setup) {
    return (
      <section className="rounded-xl border bg-card p-4 space-y-2">
        <p className="text-sm">{t('setupExpired')}</p>
        <Link href="/account" className="text-sm underline">
          {t('backToAccount')}
        </Link>
      </section>
    );
  }
  const svg = await QRCode.toString(setup.otpauthUrl, { type: 'svg', margin: 1, width: 200 });

  return (
    <>
      <h1 className="text-2xl font-semibold tracking-tight">{t('setupTitle')}</h1>
      <section className="rounded-xl border bg-card p-4 space-y-4">
        <ol className="list-decimal pl-5 text-sm space-y-1">
          <li>{t('step1')}</li>
          <li>{t('step2')}</li>
          <li>{t('step3')}</li>
        </ol>
        <div
          className="w-[200px] rounded bg-white p-1"
          role="img"
          aria-label={t('qr')}
          // Generated here from our own otpauth URL: an SVG of rects, no scripts.
          dangerouslySetInnerHTML={{ __html: svg }}
        />
        <p className="text-xs text-muted-foreground">
          {t('manualKey')} <code className="select-all break-all">{setup.secret}</code>
        </p>
        <ActionForm
          action={enableMfaAction}
          submitLabel={t('confirm')}
          secretHint={t('codesOnce')}
          className="flex flex-wrap items-start gap-2"
        >
          <input
            name="code"
            required
            inputMode="numeric"
            pattern="\d{6}"
            autoComplete="one-time-code"
            placeholder="123456"
            aria-label={t('code')}
            className="rounded-md border px-3 py-1.5 text-sm font-mono w-32"
          />
        </ActionForm>
        <Link href="/account" className="text-sm underline">
          {t('backToAccount')}
        </Link>
      </section>
    </>
  );
}
