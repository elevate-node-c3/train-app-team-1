import { Injectable, Logger } from '@nestjs/common';

import { RedisClientService } from './redis-client.service.js';

/**
 * Read-through caching with a JSON codec, over the shared Redis client.
 *
 * Degrade, never fail. Redis being down, slow, out of memory or holding a
 * value this caller cannot decode all mean the same thing here: a miss. The
 * caller then reads its source of truth and returns the same answer it always
 * would, a little slower. That is the contract `RateLimitStore` already keeps,
 * and for a read path it is the whole point -- a cache outage must not become
 * a search outage.
 *
 * Key construction and lifetimes are deliberately NOT here. They are policy,
 * they differ per caller, and keeping them out means this stays a seam rather
 * than a place decisions accumulate.
 */
@Injectable()
export class CacheAsideService {
  private readonly logger = new Logger(CacheAsideService.name);

  constructor(private readonly redis: RedisClientService) {}

  /** The decoded value, or null for a miss, an outage or an unreadable entry. */
  async get<T>(key: string): Promise<T | null> {
    const client = this.redis.isAvailable() ? this.redis.getClient() : null;
    if (!client) return null;

    try {
      const raw = await client.get(key);
      if (raw === null) return null;

      return JSON.parse(raw) as T;
    } catch (error: unknown) {
      // Includes a JSON parse failure, which is what a value written by an
      // older deploy looks like. Logged at debug: on a hot read path this
      // would otherwise be the noisiest line in the service.
      this.logger.debug(
        `Cache read failed for ${key}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return null;
    }
  }

  /** Stores a value, or quietly does not. */
  async set(key: string, value: unknown, ttlSeconds: number): Promise<void> {
    const client = this.redis.isAvailable() ? this.redis.getClient() : null;
    if (!client) return;

    try {
      await client.set(key, JSON.stringify(value), 'EX', ttlSeconds);
    } catch (error: unknown) {
      this.logger.debug(
        `Cache write failed for ${key}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
}
