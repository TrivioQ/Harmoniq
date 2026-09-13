import { describe, it, expect, vi } from 'vitest';
import { S3StorageAdapter } from '../adapters/storage/S3StorageAdapter';
import { GCSStorageAdapter } from '../adapters/storage/GCSStorageAdapter';

// Mock the AWS SDK
vi.mock('@aws-sdk/client-s3', () => {
  return {
    S3Client: class {},
    PutObjectCommand: class {},
    GetObjectCommand: class {},
    HeadObjectCommand: class {},
    DeleteObjectCommand: class {},
  };
});
vi.mock('@aws-sdk/s3-request-presigner', () => {
  return {
    getSignedUrl: vi.fn().mockResolvedValue('https://s3.mock/url'),
  };
});

// Mock the GCP SDK
vi.mock('@google-cloud/storage', () => {
  return {
    Storage: class {
      bucket() {
        return {
          file: () => ({
            getSignedUrl: vi.fn().mockResolvedValue(['https://gcs.mock/url']),
            exists: vi.fn().mockResolvedValue([true]),
            delete: vi.fn().mockResolvedValue(true),
          }),
        };
      }
    },
  };
});

describe('Storage Adapters', () => {
  it('S3StorageAdapter should return an upload URL', async () => {
    const s3 = new S3StorageAdapter('us-east-1', 'test-bucket', 'key', 'secret');
    const url = await s3.getUploadUrl('test-key.js', 'application/javascript');
    expect(url).toBe('https://s3.mock/url');
  });

  it('GCSStorageAdapter should return an upload URL', async () => {
    const gcs = new GCSStorageAdapter(
      'test-project',
      'client@test.iam.gserviceaccount.com',
      '-----BEGIN PRIVATE KEY-----\nfake\n-----END PRIVATE KEY-----\n',
      'test-bucket'
    );
    const url = await gcs.getUploadUrl('test-key.js', 'application/javascript');
    expect(url).toBe('https://gcs.mock/url');
  });
});
