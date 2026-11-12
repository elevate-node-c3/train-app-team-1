import { Injectable, Logger, Optional } from '@nestjs/common';

import { CacheFamily, CacheMetrics } from './cache-metrics.js';
import { RedisClientService } from './redis-client.service.js';
import { StampedeGuard } from './stampede-guard.js';

export const REDIS_OP_TIMEOUT_MS = 150;

/**
 * Executes a promise with a hard timeout, rejecting if not finished in time (§2.3 rule 7).
 */
async function withTimeout<T>(
  promise: Promise<T>,
  ms: number = REDIS_OP_TIMEOUT_MS,
  label = 'Redis operation',
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`${label} timed out after ${ms}ms`)),
      ms,
    );
  });
  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Read-through caching with a JSON codec, over the shared Redis client.
 *
 * Degrade, never fail. Redis being down, slow, out of memory or holding a
 * value this caller cannot decode all mean the same thing here: a miss. The
 * caller then reads its source of truth and returns the same answer it always
 * would, a little slower. That is the contract `RateLimitStore` already keeps,
 * and for a read path it is the whole point -- a cache outage must not become
 * a search outage.
 */
@Injectable()
export class CacheAsideService {
  private readonly logger = new Logger(CacheAsideService.name);
  private readonly metrics: CacheMetrics;
  private readonly stampedeGuard: StampedeGuard;

  constructor(
    private readonly redis: RedisClientService,
    @Optional() metrics?: CacheMetrics,
    @Optional() stampedeGuard?: StampedeGuard,
  ) {
    this.metrics = metrics ?? new CacheMetrics();
    this.stampedeGuard = stampedeGuard ?? new StampedeGuard();
  }

  /** The decoded value, or null for a miss, an outage or an unreadable entry. */
  async get<T>(key: string): Promise<T | null> {
    const client = this.redis.isAvailable() ? this.redis.getClient() : null;
    if (!client) return null;

    try {
      const raw = await withTimeout(
        client.get(key),
        REDIS_OP_TIMEOUT_MS,
        `Cache read for ${key}`,
      );
      if (raw === null) return null;

      return JSON.parse(raw) as T;
    } catch (error: unknown) {
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
      await withTimeout(
        client.set(key, JSON.stringify(value), 'EX', ttlSeconds),
        REDIS_OP_TIMEOUT_MS,
        `Cache write for ${key}`,
      );
    } catch (error: unknown) {
      this.logger.debug(
        `Cache write failed for ${key}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  /**
   * Removes a key, or quietly does not.
   */
  async del(key: string): Promise<void> {
    const client = this.redis.isAvailable() ? this.redis.getClient() : null;
    if (!client) return;

    try {
      await withTimeout(
        client.del(key),
        REDIS_OP_TIMEOUT_MS,
        `Cache delete for ${key}`,
      );
    } catch (error: unknown) {
      this.logger.debug(
        `Cache delete failed for ${key}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  /**
   * Distributed stampede-protected read-through caching (§2.3 rule 3).
   *
   * Coalesces concurrent misses on the same key across processes using Redis
   * distributed locks and within the local process using singleflight promises.
   */
  async getOrRebuild<T>(
    key: string,
    family: CacheFamily,
    loader: () => Promise<T>,
    ttlSeconds: number,
    options?: { maxWaitMs?: number; pollIntervalMs?: number },
  ): Promise<T> {
    const client = this.redis.isAvailable() ? this.redis.getClient() : null;
    if (!client) {
      this.metrics.recordMiss(family);
      return loader();
    }

    // 1. Initial Redis lookup
    const cached = await this.get<T>(key);
    if (cached !== null) {
      this.metrics.recordHit(family);
      return cached;
    }

    this.metrics.recordMiss(family);

    // 2. Coalesce in-process callers so multiple local queries share one promise
    return this.stampedeGuard.coalesceInProcess(key, async () => {
      // Re-check cache in case another caller populated it while waiting
      const warmCheck = await this.get<T>(key);
      if (warmCheck !== null) {
        return warmCheck;
      }

      const lockKey = `lock:${key}`;
      const lock = await this.stampedeGuard.acquireLock(client, lockKey, 5000);

      if (lock.acquired) {
        try {
          const value = await loader();
          if (value !== null && value !== undefined) {
            await this.set(key, value, ttlSeconds);
          }
          return value;
        } finally {
          await this.stampedeGuard.releaseLock(client, lock);
        }
      }

      // If lock was not acquired, another worker is rebuilding: poll until ready or timeout
      const maxWaitMs = options?.maxWaitMs ?? 1000;
      const pollIntervalMs = options?.pollIntervalMs ?? 25;
      const start = Date.now();

      while (Date.now() - start < maxWaitMs) {
        await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
        const warm = await this.get<T>(key);
        if (warm !== null) {
          return warm;
        }

        const stillLocked = await this.stampedeGuard.isLocked(client, lockKey);
        if (!stillLocked) {
          const finalCheck = await this.get<T>(key);
          if (finalCheck !== null) return finalCheck;
          break;
        }
      }

      // If wait timed out or lock was dropped without value: degrade to direct rebuild
      return loader();
    });
  }

  getMetrics(): CacheMetrics {
    return this.metrics;
  }
}
