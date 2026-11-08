import { Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { Redis } from 'ioredis';

export const RELEASE_LOCK_LUA = `
if redis.call("get", KEYS[1]) == ARGV[1] then
  return redis.call("del", KEYS[1])
else
  return 0
end
`;

export interface StampedeLock {
  lockKey: string;
  workerId: string;
  acquired: boolean;
}

/**
 * Distributed lease coordinator across multiple catalog instances (§2.3 rule 3).
 *
 * Winner gets the lock and executes the database rebuild.
 * Losers await the cached result rather than hammering Postgres.
 */
@Injectable()
export class StampedeGuard {
  private readonly logger = new Logger(StampedeGuard.name);
  private readonly inFlightPromises = new Map<string, Promise<unknown>>();

  /**
   * Deduplicates concurrent calls within the same Node process so that only one
   * call per key acquires the distributed lock.
   */
  async coalesceInProcess<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const existing = this.inFlightPromises.get(key);
    if (existing) {
      return existing as Promise<T>;
    }

    const promise = fn().finally(() => {
      this.inFlightPromises.delete(key);
    });

    this.inFlightPromises.set(key, promise);
    return promise;
  }

  /**
   * Attempts to acquire a short-lived distributed lease in Redis.
   */
  async acquireLock(
    client: Redis,
    lockKey: string,
    ttlMs = 5000,
  ): Promise<StampedeLock> {
    const workerId = randomUUID();
    try {
      const res = await client.set(lockKey, workerId, 'PX', ttlMs, 'NX');
      return {
        lockKey,
        workerId,
        acquired: res === 'OK',
      };
    } catch (err: unknown) {
      this.logger.debug(
        `Failed to acquire stampede lock ${lockKey}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      // Degrade gracefully: if lock cannot be acquired due to Redis error, treat as acquired to allow DB query
      return { lockKey, workerId, acquired: true };
    }
  }

  /**
   * Releases the distributed lease only if held by this worker.
   */
  async releaseLock(client: Redis, lock: StampedeLock): Promise<void> {
    if (!lock.acquired) return;
    try {
      await client.eval(RELEASE_LOCK_LUA, 1, lock.lockKey, lock.workerId);
    } catch (err: unknown) {
      this.logger.debug(
        `Failed to release stampede lock ${lock.lockKey}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  /**
   * Checks whether the lock is still held by someone.
   */
  async isLocked(client: Redis, lockKey: string): Promise<boolean> {
    try {
      const exists = await client.exists(lockKey);
      return exists === 1;
    } catch {
      return false;
    }
  }
}
