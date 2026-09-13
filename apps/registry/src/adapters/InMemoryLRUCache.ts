import { ICache } from '@harmoniq/core/dist/ports/ICache';
import { LRUCache } from 'lru-cache';

export class InMemoryLRUCache implements ICache {
  private cache: LRUCache<string, string>;

  constructor(options?: LRUCache.Options<string, string, unknown>) {
    this.cache = new LRUCache(options || { max: 10000, ttl: 1000 * 60 * 60 });
  }

  async get(key: string): Promise<string | null> {
    const val = this.cache.get(key);
    return val !== undefined ? val : null;
  }

  async set(key: string, value: string, ttlSeconds?: number): Promise<void> {
    if (ttlSeconds) {
      this.cache.set(key, value, { ttl: ttlSeconds * 1000 });
    } else {
      this.cache.set(key, value);
    }
  }

  async del(key: string): Promise<void> {
    this.cache.delete(key);
  }

  async invalidatePattern(pattern: string): Promise<void> {
    // Simple brute-force pattern matching for LRU cache (not ideal for huge caches, but this is a fallback)
    const regex = new RegExp(`^${pattern.replace(/\*/g, '.*')}$`);
    const keysToDelete: string[] = [];

    for (const key of this.cache.keys()) {
      if (regex.test(key)) {
        keysToDelete.push(key);
      }
    }

    for (const key of keysToDelete) {
      this.cache.delete(key);
    }
  }
}
