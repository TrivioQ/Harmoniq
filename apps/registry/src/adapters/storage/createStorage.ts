import type { WorkspaceStorageConfig } from '@prisma/client';
import { IStorage } from './IStorage';
import { S3StorageAdapter } from './S3StorageAdapter';
import { GCSStorageAdapter } from './GCSStorageAdapter';
import { decryptJson } from '../../services/crypto';
import { LocalStorageAdapter } from './LocalStorageAdapter';
import { AzureBlobStorageAdapter } from './AzureBlobStorageAdapter';
import type { StorageSettings } from '@harmoniq/core/dist/schemas/InstanceSettingsSchemas';
import type { Config } from '../../config';

/** Builds the adapter for a workspace's own bucket (BYOB-02/03) from plain credentials. */
export function workspaceStorage(
  config: Pick<WorkspaceStorageConfig, 'provider' | 'bucket' | 'region' | 'endpoint'>,
  creds: Record<string, string>
): IStorage {
  switch (config.provider) {
    case 'S3':
      return new S3StorageAdapter(
        config.region,
        config.bucket,
        creds.accessKeyId,
        creds.secretAccessKey,
        config.endpoint ?? undefined,
        creds.roleArn ? { roleArn: creds.roleArn, externalId: creds.externalId } : undefined
      );
    case 'GCS': {
      const key = creds.serviceAccountJson
        ? (JSON.parse(creds.serviceAccountJson) as Record<string, string>)
        : {
            project_id: creds.projectId,
            client_email: creds.clientEmail,
            private_key: creds.privateKey,
          };
      return new GCSStorageAdapter(
        key.project_id ?? '',
        key.client_email ?? '',
        key.private_key ?? '',
        config.bucket
      );
    }
    case 'AZURE':
      return new AzureBlobStorageAdapter(creds.connectionString ?? '', config.bucket);
    default:
      throw new Error(`Unsupported storage provider: ${config.provider}`);
  }
}

/** Builds the adapter for a workspace's own bucket, decrypting its credentials. */
export function createWorkspaceStorage(
  config: WorkspaceStorageConfig,
  encryptionKey: Buffer
): IStorage {
  return workspaceStorage(
    config,
    decryptJson<Record<string, string>>(config.credentialsEncrypted, encryptionKey)
  );
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
  return storageTarget(config, createWorkspaceStorage(config, encryptionKey));
}

/** A workspace bucket as a target: its path prefix and CDN prefix (BYOB-08). */
export function storageTarget(
  config: Pick<WorkspaceStorageConfig, 'pathPrefix' | 'cdnPrefix'>,
  storage: IStorage
): StorageTarget {
  const prefix = config.pathPrefix ? `${config.pathPrefix.replace(/^\/|\/$/g, '')}/` : '';
  return {
    storage,
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
    case 'azure':
      return {
        storage: new AzureBlobStorageAdapter(settings.connectionString ?? '', settings.container),
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
