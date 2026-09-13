import { IStorage } from './IStorage';
import { Storage } from '@google-cloud/storage';

export class GCSStorageAdapter implements IStorage {
  private storage: Storage;
  private bucket: string;

  constructor(projectId: string, clientEmail: string, privateKey: string, bucket: string) {
    this.bucket = bucket;
    this.storage = new Storage({
      projectId,
      credentials: {
        client_email: clientEmail,
        private_key: privateKey.replace(/\\n/g, '\n'), // Handle escaped newlines
      }
    });
  }

  async getUploadUrl(key: string, contentType: string): Promise<string> {
    const [url] = await this.storage
      .bucket(this.bucket)
      .file(key)
      .getSignedUrl({
        version: 'v4',
        action: 'write',
        expires: Date.now() + 60 * 60 * 1000, // 1 hour
        contentType
      });
    return url;
  }

  async getDownloadUrl(key: string): Promise<string> {
    const [url] = await this.storage
      .bucket(this.bucket)
      .file(key)
      .getSignedUrl({
        version: 'v4',
        action: 'read',
        expires: Date.now() + 60 * 60 * 1000, // 1 hour
      });
    return url;
  }

  async exists(key: string): Promise<boolean> {
    const [exists] = await this.storage.bucket(this.bucket).file(key).exists();
    return exists;
  }

  async delete(key: string): Promise<void> {
    try {
      await this.storage.bucket(this.bucket).file(key).delete();
    } catch (err: any) {
      if (err.code !== 404) {
        throw err;
      }
    }
  }
}
