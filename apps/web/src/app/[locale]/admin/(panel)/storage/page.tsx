import { getTranslations } from 'next-intl/server';
import { ActionForm } from '@/components/ActionForm';
import { adminApi } from '@/lib/adminApi';
import { saveSettingAction, testStorageAction } from '../actions';
import { SettingSource } from '../SettingSource';

const input = 'block w-full rounded-md border px-3 py-1.5 text-sm';

function Field(props: React.InputHTMLAttributes<HTMLInputElement> & { label: string }) {
  const { label, ...rest } = props;
  return (
    <label className="text-sm space-y-1 block">
      <span>{label}</span>
      <input className={input} {...rest} />
    </label>
  );
}

/** INST-11: the default storage for published manifests and bundles. */
export default async function AdminStoragePage() {
  const t = await getTranslations('AdminSettings');
  const { storage } = await adminApi.settings();
  const v = storage.value;
  const s3: Partial<typeof v> = v.adapter === 's3' ? v : {};
  const gcs: Partial<typeof v> = v.adapter === 'gcs' ? v : {};
  const azure: Partial<typeof v> = v.adapter === 'azure' ? v : {};

  return (
    <div className="space-y-6 max-w-3xl">
      <h1 className="text-2xl font-bold text-gray-900">{t('storageTitle')}</h1>
      <p className="text-sm text-gray-600">{t('storageDescription')}</p>
      <SettingSource settingKey="storage" source={storage.source} />
      <section className="bg-white p-4 rounded-lg shadow-sm border border-gray-100">
        <ActionForm
          action={saveSettingAction.bind(null, 'storage')}
          submitLabel={t('storageSave')}
          className="space-y-4"
        >
          <label className="text-sm space-y-1 block max-w-xs">
            <span>{t('adapter')}</span>
            <select name="adapter" defaultValue={v.adapter} className={input}>
              <option value="none">{t('adapterNone')}</option>
              <option value="local">{t('adapterLocal')}</option>
              <option value="s3">Amazon S3 / S3-compatible</option>
              <option value="gcs">Google Cloud Storage</option>
              <option value="azure">Azure Blob Storage</option>
            </select>
          </label>
          <fieldset className="grid gap-3 sm:grid-cols-2 border rounded-md p-3">
            <legend className="text-xs text-gray-500 px-1">Amazon S3 / S3-compatible</legend>
            <Field name="s3Bucket" label={t('bucket')} defaultValue={s3.bucket} />
            <Field name="s3Region" label={t('region')} defaultValue={s3.region} />
            <Field name="s3Endpoint" label={t('endpoint')} defaultValue={s3.endpoint} />
            <Field name="s3PublicUrl" label={t('publicUrl')} defaultValue={s3.publicUrl} />
            <Field name="s3AccessKeyId" label={t('accessKeyId')} defaultValue={s3.accessKeyId} />
            <Field
              name="s3SecretAccessKey"
              type="password"
              autoComplete="off"
              label={t('secret')}
              placeholder={
                s3.secretAccessKey ? t('keepSecret', { masked: s3.secretAccessKey }) : ''
              }
            />
          </fieldset>
          <fieldset className="grid gap-3 sm:grid-cols-2 border rounded-md p-3">
            <legend className="text-xs text-gray-500 px-1">Google Cloud Storage</legend>
            <Field name="gcsBucket" label={t('bucket')} defaultValue={gcs.bucket} />
            <Field name="gcsProjectId" label={t('projectId')} defaultValue={gcs.projectId} />
            <Field name="gcsClientEmail" label={t('clientEmail')} defaultValue={gcs.clientEmail} />
            <Field name="gcsPublicUrl" label={t('publicUrl')} defaultValue={gcs.publicUrl} />
            <label className="text-sm space-y-1 block sm:col-span-2">
              <span>{t('privateKey')}</span>
              <textarea
                name="gcsPrivateKey"
                rows={3}
                className={`${input} font-mono`}
                placeholder={gcs.privateKey ? t('keepSecret', { masked: gcs.privateKey }) : ''}
              />
            </label>
          </fieldset>
          <fieldset className="grid gap-3 sm:grid-cols-2 border rounded-md p-3">
            <legend className="text-xs text-gray-500 px-1">Azure Blob Storage</legend>
            <Field name="azureContainer" label={t('container')} defaultValue={azure.container} />
            <Field name="azurePublicUrl" label={t('publicUrl')} defaultValue={azure.publicUrl} />
            <Field
              name="azureConnectionString"
              type="password"
              autoComplete="off"
              label={t('connectionString')}
              placeholder={
                azure.connectionString ? t('keepSecret', { masked: azure.connectionString }) : ''
              }
            />
          </fieldset>
          <p className="text-xs text-gray-500">{t('storageTestHint')}</p>
        </ActionForm>
      </section>
      <ActionForm action={testStorageAction} submitLabel={t('testConnection')} variant="outline" />
    </div>
  );
}
