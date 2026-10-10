import type { WorkspaceStorageConfig } from '@prisma/client';
import { IStorage } from './IStorage';
import { S3StorageAdapter } from './S3StorageAdapter';
import { GCSStorageAdapter } from './GCSStorageAdapter';
import { decryptJson } from '../../services/crypto';
import { LocalStorageAdapter } from './LocalStorageAdapter';
import type { StorageSettings } from '@harmoniq/core/dist/schemas/InstanceSettingsSchemas';
import type { Config } from '../../config';

/** Builds the adapter for a workspace's own bucket, decrypting its credentials. */
export function createWorkspaceStorage(
  config: WorkspaceStorageConfig,
  encryptionKey: Buffer
): IStorage {
  const creds = decryptJson<Record<string, string>>(config.credentialsEncrypted, encryptionKey);

  switch (config.provider) {
    case 'S3':
      return new S3StorageAdapter(
        config.region,
        config.bucket,
        creds.accessKeyId ?? '',
        creds.secretAccessKey ?? ''
      );
    case 'GCS':
      return new GCSStorageAdapter(
        creds.projectId ?? '',
        creds.clientEmail ?? '',
        creds.privateKey ?? '',
        config.bucket
      );
    default:
      throw new Error(`Unsupported storage provider: ${config.provider}`);
  }
}

/** Where objects are written and how clients reach them. */
export interface StorageTarget {
  storage: IStorage;
  /** Key prefix inside the bucket (workspace `pathPrefix`). */
  prefix: string;
  /** Public URL for a key, or null when the bucket has no public/CDN address. */
  publicUrl(key: string): string | null;
}

const joinUrl = (base: string, key: string) => `${base.replace(/\/$/, '')}/${key}`;

export function workspaceStorageTarget(
  config: WorkspaceStorageConfig,
  encryptionKey: Buffer
): StorageTarget {
  const prefix = config.pathPrefix ? `${config.pathPrefix.replace(/^\/|\/$/g, '')}/` : '';
  return {
    storage: createWorkspaceStorage(config, encryptionKey),
    prefix,
    publicUrl: (key) => (config.cdnPrefix ? joinUrl(config.cdnPrefix, key) : null),
  };
}

/**
 * INST-11: the instance default storage from admin-panel settings (secrets opened).
 * Same shapes as the environment's, plus GCS.
 */
export function storageTargetFromSettings(
  settings: StorageSettings,
  config: Pick<Config, 'publicUrl' | 'localStorageDir'>
): StorageTarget | null {
  switch (settings.adapter) {
    case 'local':
      return instanceStorageTarget({
        ...config,
        storage: { adapter: 'local', dir: config.localStorageDir },
      });
    case 's3':
      return instanceStorageTarget({ ...config, storage: settings });
    case 'gcs':
      return {
        storage: new GCSStorageAdapter(
          settings.projectId,
          settings.clientEmail,
          settings.privateKey ?? '',
          settings.bucket
        ),
        prefix: '',
        publicUrl: (key) => (settings.publicUrl ? joinUrl(settings.publicUrl, key) : null),
      };
    default:
      return null;
  }
}

export function instanceStorageTarget(
  config: Pick<Config, 'publicUrl' | 'storage'>
): StorageTarget | null {
  const s = config.storage;
  if (s.adapter === 'local') {
    const storage = new LocalStorageAdapter(s.dir, config.publicUrl);
    return { storage, prefix: '', publicUrl: (key) => joinUrl(`${config.publicUrl}/static`, key) };
  }
  if (s.adapter === 's3') {
    return {
      storage: new S3StorageAdapter(
        s.region,
        s.bucket,
        s.accessKeyId,
        s.secretAccessKey,
        s.endpoint
      ),
      prefix: '',
      publicUrl: (key) => (s.publicUrl ? joinUrl(s.publicUrl, key) : null),
    };
  }
  return null;
}
