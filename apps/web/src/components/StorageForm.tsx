'use client';

import { useActionState, useState } from 'react';
import { useTranslations } from 'next-intl';
import type { WorkspaceStorageConfigResponse } from '@harmoniq/core/dist/schemas/WorkspaceStorageConfigSchema';
import {
  StorageState,
  removeStorageConfig,
  saveStorageConfig,
  testStorageConfig,
} from '@/app/[locale]/storageActions';

const input = 'mt-1 block w-full rounded-md border py-2 px-3 text-sm';
const label = 'block text-sm font-medium';
type Provider = 'S3' | 'GCS' | 'AZURE';

/** BYOB-01..06, 12: a workspace's own bucket (workspace settings and the admin panel). */
export function StorageForm({
  slug,
  initial,
}: {
  slug: string;
  initial: WorkspaceStorageConfigResponse | null;
}) {
  const t = useTranslations('WorkspaceStoragePage');
  const [saveState, save, saving] = useActionState<StorageState, FormData>(
    saveStorageConfig.bind(null, slug),
    { status: 'idle' }
  );
  const [testState, test, testing] = useActionState<StorageState, FormData>(
    testStorageConfig.bind(null, slug),
    { status: 'idle' }
  );
  const [removeState, remove, removing] = useActionState<StorageState, FormData>(
    removeStorageConfig.bind(null, slug),
    { status: 'idle' }
  );
  const saved =
    removeState.status === 'removed'
      ? null
      : saveState.status === 'saved'
        ? saveState.config
        : initial;
  const [provider, setProvider] = useState<Provider>(saved?.provider ?? 'S3');
  const masked = saved?.provider === provider ? saved.maskedCredentials : {};

  // Secrets are never sent back to the browser: fields start empty, and the placeholder
  // shows the masked stored value. Leaving them blank keeps the stored credentials.
  const secretField = (name: string, multiline = false) => (
    <div key={name}>
      <label className={label} htmlFor={name}>
        {t(name)}
      </label>
      {multiline ? (
        <textarea
          id={name}
          name={name}
          rows={4}
          className={`${input} font-mono`}
          placeholder={masked[name] ?? ''}
        />
      ) : (
        <input
          id={name}
          name={name}
          type={/secret|connection/i.test(name) ? 'password' : 'text'}
          autoComplete="off"
          className={input}
          placeholder={masked[name] ?? ''}
        />
      )}
    </div>
  );
  const plainField = (
    name: 'bucket' | 'region' | 'endpoint' | 'cdnPrefix' | 'pathPrefix',
    props: React.InputHTMLAttributes<HTMLInputElement> = {}
  ) => (
    <div>
      <label className={label} htmlFor={name}>
        {t(name)}
      </label>
      <input id={name} name={name} defaultValue={saved?.[name]} className={input} {...props} />
    </div>
  );

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        {saved ? t('byobActive') : t('instanceDefaultHint')}
      </p>
      {saved && (
        <p className="text-xs text-muted-foreground">
          {t('lastVerified', {
            when: saved.lastVerifiedAt ? new Date(saved.lastVerifiedAt).toLocaleString() : '—',
          })}
        </p>
      )}

      <form action={save} className="space-y-4">
        <div>
          <label className={label} htmlFor="provider">
            {t('storageProvider')}
          </label>
          <select
            id="provider"
            name="provider"
            value={provider}
            onChange={(e) => setProvider(e.target.value as Provider)}
            className={input}
          >
            <option value="S3">{t('s3')}</option>
            <option value="GCS">{t('gcs')}</option>
            <option value="AZURE">{t('azure')}</option>
          </select>
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          {plainField('bucket', { required: true })}
          {plainField('region', { required: true, placeholder: 'eu-west-1' })}
          {plainField('cdnPrefix', { type: 'url', placeholder: 'https://cdn.example.com/mfe' })}
          {plainField('pathPrefix', { placeholder: 'harmoniq' })}
          {provider === 'S3' &&
            plainField('endpoint', { type: 'url', placeholder: 'https://minio.example.com' })}
        </div>

        <fieldset className="space-y-4">
          <legend className="text-sm text-muted-foreground">
            {saved ? t('credentialsKeepHint') : t('credentialsRequiredHint')}
          </legend>
          {provider === 'S3' && (
            <>
              <div className="grid gap-4 sm:grid-cols-2">
                {secretField('accessKeyId')}
                {secretField('secretAccessKey')}
              </div>
              <p className="text-xs text-muted-foreground">{t('orRole')}</p>
              <div className="grid gap-4 sm:grid-cols-2">
                {secretField('roleArn')}
                {secretField('externalId')}
              </div>
            </>
          )}
          {provider === 'GCS' && secretField('serviceAccountJson', true)}
          {provider === 'AZURE' && secretField('connectionString')}
        </fieldset>

        <p className="text-xs text-muted-foreground">{t('verifyHint')}</p>
        <div className="flex gap-2">
          <button
            type="submit"
            disabled={saving}
            className="py-2 px-4 rounded-md text-sm font-medium bg-primary text-primary-foreground disabled:opacity-50"
          >
            {saving ? t('saving') : t('saveConfiguration')}
          </button>
          <button
            type="submit"
            formAction={test}
            disabled={testing}
            className="py-2 px-4 rounded-md text-sm font-medium border bg-background disabled:opacity-50"
          >
            {testing ? t('testing') : t('testConnection')}
          </button>
        </div>
      </form>

      {[saveState, testState, removeState].map((state, i) =>
        state.status === 'error' ? (
          <div key={i} role="alert" className="p-3 bg-red-50 text-red-700 text-sm rounded-md">
            {state.message}
          </div>
        ) : null
      )}
      {testState.status === 'tested' && (
        <div
          role="status"
          className={`p-3 text-sm rounded-md ${testState.ok ? 'bg-green-50 text-green-700' : 'bg-red-50 text-red-700'}`}
        >
          {testState.ok
            ? t('testOk', { ms: testState.latencyMs })
            : t('testFailed', { error: testState.error ?? '' })}
        </div>
      )}
      {saveState.status === 'saved' && (
        <div role="status" className="p-3 bg-green-50 text-green-700 text-sm rounded-md">
          {t('successUpdate')}
        </div>
      )}
      {/* BYOB-12: nothing already deployed moves. */}
      {saveState.status === 'saved' && saveState.firstTime && (
        <div className="p-3 bg-amber-50 text-amber-900 text-sm rounded-md">
          {t('migrationAdvisory')}
        </div>
      )}
      {removeState.status === 'removed' && (
        <div role="status" className="p-3 bg-green-50 text-green-700 text-sm rounded-md">
          {t('removed')}
        </div>
      )}

      {saved && (
        <form
          action={remove}
          onSubmit={(e) => {
            if (!window.confirm(t('removeConfirm'))) e.preventDefault();
          }}
        >
          <button
            type="submit"
            disabled={removing}
            className="py-2 px-4 rounded-md text-sm font-medium bg-red-600 text-white disabled:opacity-50"
          >
            {t('remove')}
          </button>
        </form>
      )}
    </div>
  );
}
