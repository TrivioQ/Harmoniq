'use client';

import { useActionState, useState } from 'react';
import { useTranslations } from 'next-intl';
import type { WorkspaceStorageConfigResponse } from '@harmoniq/core/dist/schemas/WorkspaceStorageConfigSchema';
import { SaveStorageState, saveStorageConfig } from './actions';

const input = 'mt-1 block w-full rounded-md border-gray-300 shadow-sm border py-2 px-3';
const label = 'block text-sm font-medium text-gray-700';

export function StorageForm({
  slug,
  initial,
}: {
  slug: string;
  initial: WorkspaceStorageConfigResponse | null;
}) {
  const t = useTranslations('WorkspaceStoragePage');
  const [state, action, pending] = useActionState<SaveStorageState, FormData>(
    saveStorageConfig.bind(null, slug),
    { status: 'idle' }
  );
  const saved = state.status === 'success' ? state.config : initial;
  const [provider, setProvider] = useState<'S3' | 'GCS'>(saved?.provider ?? 'S3');
  const masked = saved?.provider === provider ? saved.maskedCredentials : {};

  // Secrets are never sent back to the browser: fields start empty, and the placeholder
  // shows the masked stored value. Leaving them blank keeps the stored credentials.
  const secretField = (name: string, labelKey: string, multiline = false) => (
    <div key={name}>
      <label className={label} htmlFor={name}>
        {t(labelKey)}
      </label>
      {multiline ? (
        <textarea
          id={name}
          name={name}
          rows={4}
          className={input}
          placeholder={masked[name] ?? ''}
        />
      ) : (
        <input
          id={name}
          name={name}
          type={name === 'secretAccessKey' ? 'password' : 'text'}
          autoComplete="off"
          className={input}
          placeholder={masked[name] ?? ''}
        />
      )}
    </div>
  );

  return (
    <form action={action} className="space-y-6">
      <p className="text-sm text-gray-500">{t('instanceDefaultHint')}</p>

      <div>
        <label className={label} htmlFor="provider">
          {t('storageProvider')}
        </label>
        <select
          id="provider"
          name="provider"
          value={provider}
          onChange={(e) => setProvider(e.target.value as 'S3' | 'GCS')}
          className={input}
        >
          <option value="S3">{t('s3')}</option>
          <option value="GCS">{t('gcs')}</option>
        </select>
      </div>

      <div>
        <label className={label} htmlFor="bucket">
          {t('bucketName')}
        </label>
        <input id="bucket" name="bucket" required defaultValue={saved?.bucket} className={input} />
      </div>
      <div>
        <label className={label} htmlFor="region">
          {t('region')}
        </label>
        <input
          id="region"
          name="region"
          required
          defaultValue={saved?.region}
          placeholder="us-east-1"
          className={input}
        />
      </div>
      <div>
        <label className={label} htmlFor="cdnPrefix">
          {t('cdnPrefix')}
        </label>
        <input
          id="cdnPrefix"
          name="cdnPrefix"
          type="url"
          defaultValue={saved?.cdnPrefix}
          placeholder="https://cdn.example.com/mfe"
          className={input}
        />
      </div>

      <fieldset className="space-y-4">
        <legend className="text-sm text-gray-500">
          {saved ? t('credentialsKeepHint') : t('credentialsRequiredHint')}
        </legend>
        {provider === 'S3'
          ? [
              secretField('accessKeyId', 'accessKeyId'),
              secretField('secretAccessKey', 'secretAccessKey'),
            ]
          : [
              secretField('projectId', 'projectId'),
              secretField('clientEmail', 'clientEmail'),
              secretField('privateKey', 'privateKey', true),
            ]}
      </fieldset>

      {state.status === 'error' && (
        <div role="alert" className="p-3 bg-red-50 text-red-700 text-sm rounded-md">
          {state.message}
        </div>
      )}
      {state.status === 'success' && (
        <div role="status" className="p-3 bg-green-50 text-green-700 text-sm rounded-md">
          {t('successUpdate')}
        </div>
      )}

      <div className="flex justify-end">
        <button
          type="submit"
          disabled={pending}
          className="py-2 px-4 border border-transparent rounded-md shadow-sm text-sm font-medium text-white bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50"
        >
          {pending ? t('saving') : t('saveConfiguration')}
        </button>
      </div>
    </form>
  );
}
