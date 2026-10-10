// Copyright The Harmoniq Authors
// SPDX-License-Identifier: Apache-2.0

export interface IStorage {
  /**
   * Generates a pre-signed URL for uploading a file directly to the storage bucket.
   */
  getUploadUrl(key: string, contentType: string): Promise<string>;

  /**
   * Generates a pre-signed URL for downloading a file directly from the storage bucket.
   */
  getDownloadUrl(key: string): Promise<string>;

  /**
   * Checks if a file exists in the storage bucket.
   */
  exists(key: string): Promise<boolean>;

  /**
   * Deletes a file from the storage bucket.
   */
  delete(key: string): Promise<void>;

  /**
   * Writes an object directly (e.g. published manifests). `cacheControl` is served by the
   * bucket/CDN to clients.
   */
  put(
    key: string,
    body: string,
    opts: { contentType: string; cacheControl?: string }
  ): Promise<void>;
}
