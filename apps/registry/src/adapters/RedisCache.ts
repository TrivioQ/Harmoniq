import { ICache } from '@harmoniq/core/dist/ports/ICache';
import Redis, { RedisOptions } from 'ioredis';

export class RedisCache implements ICache {
  private redis: Redis;

  constructor(url: string, options?: RedisOptions) {
    if (options) {
      this.redis = new Redis(url, options);
    } else {
      this.redis = new Redis(url);
    }
  }

  async get(key: string): Promise<string | null> {
    return this.redis.get(key);
  }

  async set(key: string, value: string, ttlSeconds?: number): Promise<void> {
    if (ttlSeconds) {
      await this.redis.set(key, value, 'EX', ttlSeconds);
    } else {
      await this.redis.set(key, value);
    }
  }

  async del(key: string): Promise<void> {
    await this.redis.del(key);
  }

  async invalidatePattern(pattern: string): Promise<void> {
    // We can use the SCAN command to find keys matching the pattern and delete them
    // pattern should be a redis pattern like "manifest:*"
    let cursor = '0';

    do {
      const [nextCursor, keys] = await this.redis.scan(cursor, 'MATCH', pattern, 'COUNT', 100);
      cursor = nextCursor;

      if (keys.length > 0) {
        await this.redis.del(...keys);
      }
    } while (cursor !== '0');
  }
}
