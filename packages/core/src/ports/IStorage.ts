// Copyright The Harmoniq Authors
// SPDX-License-Identifier: Apache-2.0

export interface IStorage {
  upload(path: string, data: Buffer, contentType: string): Promise<string>;
  delete(path: string): Promise<void>;
  exists(path: string): Promise<boolean>;
  list(prefix: string): Promise<string[]>;
}
