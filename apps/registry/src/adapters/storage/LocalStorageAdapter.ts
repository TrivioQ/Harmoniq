// Copyright The Harmoniq Authors
// SPDX-License-Identifier: Apache-2.0

import { randomUUID } from 'crypto';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'fs/promises';
import { dirname, resolve, sep } from 'path';
import { IStorage } from './IStorage';

/**
 * Filesystem storage for development and single-node installs. Objects are served by the
 * registry at `/static/*` (see routes/static.ts). Not tenant-isolatable, so it is never
 * allowed as a workspace bucket (BYOB-02) — only as the instance default.
 */
export class LocalStorageAdapter implements IStorage {
  private root: string;

  constructor(
    root: string,
    private publicBaseUrl: string
  ) {
    this.root = resolve(root);
  }

  /** Resolves a key inside the root; rejects traversal such as `../`. */
  resolveKey(key: string): string {
    const path = resolve(this.root, key);
    if (path !== this.root && !path.startsWith(this.root + sep)) {
      throw new Error(`Invalid storage key: ${key}`);
    }
    return path;
  }

  async getUploadUrl(): Promise<string> {
    throw new Error('Pre-signed uploads are not supported by local storage');
  }

  async getDownloadUrl(key: string): Promise<string> {
    this.resolveKey(key);
    return `${this.publicBaseUrl.replace(/\/$/, '')}/static/${key}`;
  }

  async exists(key: string): Promise<boolean> {
    return stat(this.resolveKey(key)).then(
      () => true,
      () => false
    );
  }

  async delete(key: string): Promise<void> {
    await rm(this.resolveKey(key), { force: true });
  }

  async put(key: string, body: string): Promise<void> {
    const path = this.resolveKey(key);
    await mkdir(dirname(path), { recursive: true });
    // Write-then-rename: readers never see a half-written manifest.
    const tmp = `${path}.${randomUUID()}.tmp`;
    await writeFile(tmp, body);
    await rename(tmp, path);
  }

  async read(key: string): Promise<Buffer> {
    return readFile(this.resolveKey(key));
  }
}
