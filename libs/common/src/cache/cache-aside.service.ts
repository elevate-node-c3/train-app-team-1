import { Injectable, Logger, Optional } from '@nestjs/common';

import { CacheFamily, CacheMetrics } from './cache-metrics.js';
import { RedisClientService } from './redis-client.service.js';
import { StampedeGuard } from './stampede-guard.js';

export const REDIS_OP_TIMEOUT_MS = 150;

/** Rejects after the timeout in milliseconds. */
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
 * JSON caching over the shared Redis client. Outages, timeouts and decode
 * errors are cache misses, never search failures; reads fall back to the source.
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

  /** Writes are best effort; TTL is in seconds. */
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

  /** Deletes are best effort. */
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
   * Increments a counter and returns the new value, or null on an outage.
   *
   * Unlike `get`/`set`/`del`, the caller needs to know whether this landed: a
   * generation counter that silently did not move leaves stale entries
   * reachable.
   */
  async increment(key: string): Promise<number | null> {
    const client = this.redis.isAvailable() ? this.redis.getClient() : null;
    if (!client) return null;

    try {
      return await withTimeout(
        client.incr(key),
        REDIS_OP_TIMEOUT_MS,
        `Cache increment for ${key}`,
      );
    } catch (error: unknown) {
      this.logger.debug(
        `Cache increment failed for ${key}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return null;
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
    options?: {
      maxWaitMs?: number;
      pollIntervalMs?: number;
      isValid?: (value: unknown) => value is T;
    },
  ): Promise<T> {
    const isUsable = (value: T | null): value is T =>
      value !== null && (!options?.isValid || options.isValid(value));
    const client = this.redis.isAvailable() ? this.redis.getClient() : null;
    if (!client) {
      this.metrics.recordMiss(family);
      return loader();
    }

    const cached = await this.get<T>(key);
    if (isUsable(cached)) {
      this.metrics.recordHit(family);
      return cached;
    }

    this.metrics.recordMiss(family);

    return this.stampedeGuard.coalesceInProcess(key, async () => {
      // Another caller may have filled the cache while this one waited.
      const warmCheck = await this.get<T>(key);
      if (isUsable(warmCheck)) {
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

      // Wait for the lease owner's result, up to maxWaitMs.
      const maxWaitMs = options?.maxWaitMs ?? 1000;
      const pollIntervalMs = options?.pollIntervalMs ?? 25;
      const start = Date.now();

      while (Date.now() - start < maxWaitMs) {
        await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
        const warm = await this.get<T>(key);
        if (isUsable(warm)) {
          return warm;
        }

        const stillLocked = await this.stampedeGuard.isLocked(client, lockKey);
        if (!stillLocked) {
          const finalCheck = await this.get<T>(key);
          if (isUsable(finalCheck)) return finalCheck;
          break;
        }
      }

      // Rebuild directly if the wait expires or the lease ends without a value.
      return loader();
    });
  }

  getMetrics(): CacheMetrics {
    return this.metrics;
  }
}
