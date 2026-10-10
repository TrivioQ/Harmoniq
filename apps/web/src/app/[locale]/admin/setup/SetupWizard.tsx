// Copyright The Harmoniq Authors
// SPDX-License-Identifier: Apache-2.0

'use client';

import { useState, useTransition } from 'react';
import { useTranslations } from 'next-intl';
import { Link } from '@/i18n/routing';
import {
  type Check,
  type SetupState,
  checkConnectivity,
  checkStorage,
  initializeInstance,
  signInMethods,
} from './actions';

const input =
  'mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-indigo-500 focus:ring-indigo-500 sm:text-sm px-3 py-2 border';
const button =
  'flex justify-center py-2 px-4 border border-transparent rounded-md shadow-sm text-sm font-medium text-white bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50';
const secondary = 'py-2 px-4 rounded-md border text-sm text-gray-700 bg-white hover:bg-gray-50';

function CheckLine({ label, check }: { label: string; check: Check }) {
  return (
    <li className="flex justify-between text-sm">
      <span>
        {label}
        {check.adapter && <span className="text-gray-500"> ({check.adapter})</span>}
      </span>
      <span className={check.ok ? 'text-green-700' : 'text-red-700'}>
        {check.ok ? `OK · ${check.latencyMs} ms` : (check.error ?? 'FAIL')}
      </span>
    </li>
  );
}

/**
 * INST-03: (1) the first admin account, (2) database and cache, (3) default storage,
 * (4) sign-in methods. Nothing is saved until the last step.
 */
export function SetupWizard() {
  const t = useTranslations('AdminSetupPage');
  const [stepNo, setStep] = useState(1);
  const [account, setAccount] = useState({ setupToken: '', email: '', name: '' });
  const [error, setError] = useState<string | null>(null);
  const [connectivity, setConnectivity] = useState<{ database: Check; cache: Check } | null>(null);
  const [storage, setStorage] = useState<Check | null>(null);
  const [methods, setMethods] = useState<Array<{ id: string; displayName: string }> | null>(null);
  const [done, setDone] = useState<SetupState>({ status: 'idle' });
  const [pending, startTransition] = useTransition();

  const go = (next: number) => {
    setError(null);
    setStep(next);
    startTransition(async () => {
      if (next === 2) {
        const result = await checkConnectivity(account.setupToken);
        if (result.ok) setConnectivity(result.data);
        else {
          setError(result.message);
          setStep(1);
        }
      } else if (next === 3) {
        const result = await checkStorage(account.setupToken);
        if (result.ok) setStorage(result.data);
        else setError(result.message);
      } else if (next === 4) {
        setMethods(await signInMethods());
      }
    });
  };

  if (done.status === 'success') {
    return (
      <div className="space-y-4 text-center">
        <div role="status" className="p-3 bg-green-50 text-green-700 text-sm rounded-md">
          {t('successMessage', { email: done.email })}
        </div>
        <Link href="/auth/login" className="text-indigo-600 hover:text-indigo-900 text-sm">
          {t('goToSignIn')}
        </Link>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <ol className="flex justify-between text-xs text-gray-500">
        {[t('step1'), t('step2'), t('step3'), t('step4')].map((label, i) => (
          <li key={label} className={i + 1 === stepNo ? 'font-semibold text-indigo-700' : ''}>
            {i + 1}. {label}
          </li>
        ))}
      </ol>

      {stepNo === 1 && (
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            go(2);
          }}
        >
          {(
            [
              ['setupToken', t('setupToken'), 'password', 'HARMONIQ_SETUP_TOKEN', true],
              ['email', t('emailAddress'), 'email', 'admin@example.com', true],
              ['name', t('name'), 'text', 'System Admin', false],
            ] as const
          ).map(([name, label, type, placeholder, required]) => (
            <div key={name}>
              <label className="block text-sm font-medium text-gray-700" htmlFor={name}>
                {label}
              </label>
              <input
                id={name}
                type={type}
                required={required}
                placeholder={placeholder}
                value={account[name]}
                onChange={(e) => setAccount({ ...account, [name]: e.target.value })}
                className={input}
              />
            </div>
          ))}
          <p className="text-xs text-gray-500">{t('accountHint')}</p>
          <button type="submit" className={`${button} w-full`}>
            {t('next')}
          </button>
        </form>
      )}

      {stepNo === 2 && (
        <div className="space-y-4">
          <p className="text-sm text-gray-600">{t('connectivityHint')}</p>
          {pending || !connectivity ? (
            <p className="text-sm text-gray-500">{t('checking')}</p>
          ) : (
            <ul className="space-y-1">
              <CheckLine label={t('database')} check={connectivity.database} />
              <CheckLine label={t('cache')} check={connectivity.cache} />
            </ul>
          )}
          <div className="flex justify-between">
            <button className={secondary} onClick={() => setStep(1)}>
              {t('back')}
            </button>
            <button
              className={button}
              disabled={pending || !connectivity?.database.ok || !connectivity.cache.ok}
              onClick={() => go(3)}
            >
              {t('next')}
            </button>
          </div>
        </div>
      )}

      {stepNo === 3 && (
        <div className="space-y-4">
          <p className="text-sm text-gray-600">{t('storageHint')}</p>
          {pending || !storage ? (
            <p className="text-sm text-gray-500">{t('checking')}</p>
          ) : (
            <ul>
              <CheckLine label={t('storage')} check={storage} />
            </ul>
          )}
          <div className="flex justify-between">
            <button className={secondary} onClick={() => setStep(2)}>
              {t('back')}
            </button>
            <div className="flex gap-2">
              <button className={secondary} disabled={pending} onClick={() => go(3)}>
                {t('retry')}
              </button>
              <button className={button} disabled={pending || !storage?.ok} onClick={() => go(4)}>
                {t('next')}
              </button>
            </div>
          </div>
        </div>
      )}

      {stepNo === 4 && (
        <div className="space-y-4">
          <p className="text-sm text-gray-600">{t('signInHint', { email: account.email })}</p>
          {pending || !methods ? (
            <p className="text-sm text-gray-500">{t('checking')}</p>
          ) : methods.length ? (
            <ul className="list-disc pl-5 text-sm">
              {methods.map((m) => (
                <li key={m.id}>{m.displayName}</li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-red-700">{t('noSignIn')}</p>
          )}
          {done.status === 'error' && (
            <div role="alert" className="p-3 bg-red-50 text-red-700 text-sm rounded-md">
              {done.message}
            </div>
          )}
          <div className="flex justify-between">
            <button className={secondary} onClick={() => setStep(3)}>
              {t('back')}
            </button>
            <button
              className={button}
              disabled={pending || !methods?.length}
              onClick={() =>
                startTransition(async () =>
                  setDone(
                    await initializeInstance({
                      setupToken: account.setupToken,
                      email: account.email.trim(),
                      name: account.name.trim() || undefined,
                    })
                  )
                )
              }
            >
              {pending ? t('initializing') : t('initialize')}
            </button>
          </div>
        </div>
      )}

      {error && (
        <div role="alert" className="p-3 bg-red-50 text-red-700 text-sm rounded-md">
          {error}
        </div>
      )}
    </div>
  );
}
