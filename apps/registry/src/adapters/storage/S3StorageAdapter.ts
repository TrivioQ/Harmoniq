import { IStorage } from './IStorage';
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  DeleteObjectCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

export class S3StorageAdapter implements IStorage {
  private client: S3Client;
  private bucket: string;

  constructor(
    region: string,
    bucket: string,
    accessKeyId: string | undefined,
    secretAccessKey: string | undefined,
    endpoint?: string
  ) {
    this.bucket = bucket;
    this.client = new S3Client({
      region,
      endpoint,
      // Without static keys the SDK's default chain applies (env, ECS task role, IMDS).
      credentials: accessKeyId && secretAccessKey ? { accessKeyId, secretAccessKey } : undefined,
      forcePathStyle: !!endpoint, // Often required for MinIO/custom endpoints
    });
  }

  async getUploadUrl(key: string, contentType: string): Promise<string> {
    const command = new PutObjectCommand({
      Bucket: this.bucket,
      Key: key,
      ContentType: contentType,
    });
    return getSignedUrl(this.client, command, { expiresIn: 3600 });
  }

  async getDownloadUrl(key: string): Promise<string> {
    const command = new GetObjectCommand({
      Bucket: this.bucket,
      Key: key,
    });
    return getSignedUrl(this.client, command, { expiresIn: 3600 });
  }

  async exists(key: string): Promise<boolean> {
    try {
      const command = new HeadObjectCommand({
        Bucket: this.bucket,
        Key: key,
      });
      await this.client.send(command);
      return true;
    } catch (err: unknown) {
      if ((err as { name?: string })?.name === 'NotFound') {
        return false;
      }
      throw err;
    }
  }

  async delete(key: string): Promise<void> {
    const command = new DeleteObjectCommand({
      Bucket: this.bucket,
      Key: key,
    });
    await this.client.send(command);
  }

  async put(
    key: string,
    body: string,
    opts: { contentType: string; cacheControl?: string }
  ): Promise<void> {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: body,
        ContentType: opts.contentType,
        CacheControl: opts.cacheControl,
      })
    );
  }
}
