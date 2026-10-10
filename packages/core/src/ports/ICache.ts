// Copyright The Harmoniq Authors
// SPDX-License-Identifier: Apache-2.0

export interface ICache {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttlSeconds?: number): Promise<void>;
  del(key: string): Promise<void>;
  invalidatePattern(pattern: string): Promise<void>;
  /** Release connections so the process can exit. */
  close?(): Promise<void>;
}
