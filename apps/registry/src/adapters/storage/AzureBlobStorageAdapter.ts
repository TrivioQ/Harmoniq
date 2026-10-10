import {
  BlobSASPermissions,
  BlobServiceClient,
  ContainerClient,
  StorageSharedKeyCredential,
  generateBlobSASQueryParameters,
} from '@azure/storage-blob';
import { IStorage } from './IStorage';

const SAS_TTL_MS = 60 * 60 * 1000;

/**
 * BYOB-02: Azure Blob Storage, authenticated by a connection string. Pre-signed URLs are
 * SAS tokens signed with the account key from the connection string.
 */
export class AzureBlobStorageAdapter implements IStorage {
  private container: ContainerClient;
  private credential: StorageSharedKeyCredential | null;

  constructor(connectionString: string, containerName: string) {
    this.container =
      BlobServiceClient.fromConnectionString(connectionString).getContainerClient(containerName);
    const parts = Object.fromEntries(
      connectionString
        .split(';')
        .filter(Boolean)
        .map((part) => {
          const i = part.indexOf('=');
          return [part.slice(0, i), part.slice(i + 1)];
        })
    );
    this.credential =
      parts.AccountName && parts.AccountKey
        ? new StorageSharedKeyCredential(parts.AccountName, parts.AccountKey)
        : null;
  }

  private sasUrl(key: string, permissions: string, contentType?: string) {
    if (!this.credential) {
      throw new Error('Pre-signed URLs need a connection string with AccountName and AccountKey');
    }
    const blob = this.container.getBlockBlobClient(key);
    const sas = generateBlobSASQueryParameters(
      {
        containerName: this.container.containerName,
        blobName: key,
        permissions: BlobSASPermissions.parse(permissions),
        startsOn: new Date(Date.now() - 5 * 60 * 1000),
        expiresOn: new Date(Date.now() + SAS_TTL_MS),
        ...(contentType && { contentType }),
      },
      this.credential
    );
    return `${blob.url}?${sas.toString()}`;
  }

  async getUploadUrl(key: string, contentType: string): Promise<string> {
    // Uploaders send `x-ms-blob-type: BlockBlob` with the PUT.
    return this.sasUrl(key, 'cw', contentType);
  }

  async getDownloadUrl(key: string): Promise<string> {
    return this.sasUrl(key, 'r');
  }

  async exists(key: string): Promise<boolean> {
    return this.container.getBlockBlobClient(key).exists();
  }

  async delete(key: string): Promise<void> {
    await this.container.getBlockBlobClient(key).deleteIfExists();
  }

  async put(
    key: string,
    body: string,
    opts: { contentType: string; cacheControl?: string }
  ): Promise<void> {
    await this.container.getBlockBlobClient(key).upload(body, Buffer.byteLength(body), {
      blobHTTPHeaders: { blobContentType: opts.contentType, blobCacheControl: opts.cacheControl },
    });
  }
}
