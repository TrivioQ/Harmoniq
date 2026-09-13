'use client';

import React, { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';

export default function WorkspaceStoragePage({ params }: { params: { slug: string } }) {
  const t = useTranslations('WorkspaceStoragePage');
  const [provider, setProvider] = useState<'LOCAL' | 'S3' | 'GCS'>('LOCAL');
  const [config, setConfig] = useState<Record<string, string>>({});
  const [status, setStatus] = useState<'idle' | 'loading' | 'success' | 'error'>('idle');
  const [message, setMessage] = useState('');

  useEffect(() => {
    const fetchConfig = async () => {
      try {
        const token = localStorage.getItem('harmoniq_admin_token');
        const res = await fetch(
          `${process.env.NEXT_PUBLIC_REGISTRY_URL || 'http://localhost:3002'}/api/workspaces/${params.slug}/storage`,
          {
            headers: { Authorization: `Bearer ${token}` },
          }
        );
        if (res.ok) {
          const data = await res.json();
          if (data.storageConfig) {
            setProvider(data.storageConfig.provider);
            setConfig(data.storageConfig.config || {});
          }
        }
      } catch (err) {
        console.error(err);
      }
    };
    fetchConfig();
  }, [params.slug]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setStatus('loading');
    try {
      const token = localStorage.getItem('harmoniq_admin_token');
      const res = await fetch(
        `${process.env.NEXT_PUBLIC_REGISTRY_URL || 'http://localhost:3002'}/api/workspaces/${params.slug}/storage`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({ provider, config }),
        }
      );

      const data = await res.json();
      if (!res.ok) throw new Error(data.error?.message || t('errorUpdate'));

      setStatus('success');
      setMessage(t('successUpdate'));
    } catch (err: unknown) {
      setStatus('error');
      setMessage(err instanceof Error ? err.message : String(err));
    }
  };

  const handleConfigChange = (key: string, value: string) => {
    setConfig({ ...config, [key]: value });
  };

  return (
    <div className="max-w-2xl space-y-6">
      <h1 className="text-2xl font-bold text-gray-900">{t('title', { slug: params.slug })}</h1>

      <div className="bg-white p-6 rounded-lg shadow-sm border border-gray-100">
        <form onSubmit={handleSubmit} className="space-y-6">
          <div>
            <label className="block text-sm font-medium text-gray-700">
              {t('storageProvider')}
            </label>
            <select
              value={provider}
              onChange={(e) => setProvider(e.target.value as 'LOCAL' | 'S3' | 'GCS')}
              className="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-indigo-500 focus:ring-indigo-500 sm:text-sm border py-2 px-3"
            >
              <option value="LOCAL">{t('local')}</option>
              <option value="S3">{t('s3')}</option>
              <option value="GCS">{t('gcs')}</option>
            </select>
          </div>

          {provider === 'S3' && (
            <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-700">{t('region')}</label>
                <input
                  type="text"
                  value={config.region || ''}
                  onChange={(e) => handleConfigChange('region', e.target.value)}
                  className="mt-1 block w-full rounded-md border-gray-300 shadow-sm border py-2 px-3"
                  placeholder="us-east-1"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700">{t('bucketName')}</label>
                <input
                  type="text"
                  value={config.bucket || ''}
                  onChange={(e) => handleConfigChange('bucket', e.target.value)}
                  className="mt-1 block w-full rounded-md border-gray-300 shadow-sm border py-2 px-3"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700">
                  {t('accessKeyId')}
                </label>
                <input
                  type="text"
                  value={config.accessKeyId || ''}
                  onChange={(e) => handleConfigChange('accessKeyId', e.target.value)}
                  className="mt-1 block w-full rounded-md border-gray-300 shadow-sm border py-2 px-3"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700">
                  {t('secretAccessKey')}
                </label>
                <input
                  type="password"
                  value={config.secretAccessKey || ''}
                  onChange={(e) => handleConfigChange('secretAccessKey', e.target.value)}
                  className="mt-1 block w-full rounded-md border-gray-300 shadow-sm border py-2 px-3"
                />
              </div>
            </div>
          )}

          {provider === 'GCS' && (
            <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-700">{t('projectId')}</label>
                <input
                  type="text"
                  value={config.projectId || ''}
                  onChange={(e) => handleConfigChange('projectId', e.target.value)}
                  className="mt-1 block w-full rounded-md border-gray-300 shadow-sm border py-2 px-3"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700">{t('bucketName')}</label>
                <input
                  type="text"
                  value={config.bucket || ''}
                  onChange={(e) => handleConfigChange('bucket', e.target.value)}
                  className="mt-1 block w-full rounded-md border-gray-300 shadow-sm border py-2 px-3"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700">
                  {t('clientEmail')}
                </label>
                <input
                  type="text"
                  value={config.clientEmail || ''}
                  onChange={(e) => handleConfigChange('clientEmail', e.target.value)}
                  className="mt-1 block w-full rounded-md border-gray-300 shadow-sm border py-2 px-3"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700">{t('privateKey')}</label>
                <textarea
                  value={config.privateKey || ''}
                  onChange={(e) => handleConfigChange('privateKey', e.target.value)}
                  className="mt-1 block w-full rounded-md border-gray-300 shadow-sm border py-2 px-3"
                  rows={4}
                  placeholder="-----BEGIN PRIVATE KEY-----\n..."
                />
              </div>
            </div>
          )}

          {status === 'error' && (
            <div className="p-3 bg-red-50 text-red-700 text-sm rounded-md">{message}</div>
          )}
          {status === 'success' && (
            <div className="p-3 bg-green-50 text-green-700 text-sm rounded-md">{message}</div>
          )}

          <div className="flex justify-end">
            <button
              type="submit"
              disabled={status === 'loading'}
              className="py-2 px-4 border border-transparent rounded-md shadow-sm text-sm font-medium text-white bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50"
            >
              {status === 'loading' ? t('saving') : t('saveConfiguration')}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
