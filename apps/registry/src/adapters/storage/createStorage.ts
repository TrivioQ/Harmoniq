import type { WorkspaceStorageConfig } from '@prisma/client';
import { IStorage } from './IStorage';
import { S3StorageAdapter } from './S3StorageAdapter';
import { GCSStorageAdapter } from './GCSStorageAdapter';
import { decryptJson } from '../../services/crypto';

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
