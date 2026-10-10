// Copyright The Harmoniq Authors
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, vi } from 'vitest';
import { S3StorageAdapter } from '../adapters/storage/S3StorageAdapter';
import { GCSStorageAdapter } from '../adapters/storage/GCSStorageAdapter';
import { AzureBlobStorageAdapter } from '../adapters/storage/AzureBlobStorageAdapter';

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

  it('AzureBlobStorageAdapter signs a short-lived write SAS (BYOB-02)', async () => {
    const accountKey = Buffer.alloc(32, 7).toString('base64');
    const azure = new AzureBlobStorageAdapter(
      `DefaultEndpointsProtocol=https;AccountName=acme;AccountKey=${accountKey};EndpointSuffix=core.windows.net`,
      'mfe'
    );
    const url = new URL(await azure.getUploadUrl('modules/x.js', 'application/javascript'));
    expect(url.origin + url.pathname).toBe('https://acme.blob.core.windows.net/mfe/modules/x.js');
    expect(url.searchParams.get('sp')).toBe('cw');
    expect(url.searchParams.get('sig')).toBeTruthy();
    expect(new Date(url.searchParams.get('se')!).getTime()).toBeLessThanOrEqual(
      Date.now() + 60 * 60 * 1000
    );
    // Without an account key there is nothing to sign with.
    const noKey = new AzureBlobStorageAdapter(
      'BlobEndpoint=https://acme.blob.core.windows.net/;SharedAccessSignature=sv=x',
      'mfe'
    );
    await expect(noKey.getUploadUrl('k', 'text/plain')).rejects.toThrow('AccountKey');
  });
});
