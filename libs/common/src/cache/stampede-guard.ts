import { Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { Redis } from 'ioredis';

const LOCK_COMMAND_TIMEOUT_MS = 150;

async function withLockCommandTimeout<T>(operation: Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await new Promise<T>((resolve, reject) => {
      timer = setTimeout(
        () =>
          reject(
            new Error(
              `Redis lock command timed out after ${LOCK_COMMAND_TIMEOUT_MS}ms`,
            ),
          ),
        LOCK_COMMAND_TIMEOUT_MS,
      );
      // Retain rejection handling even when Redis settles after the deadline.
      void operation.then(resolve, reject);
    });
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

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

/** The lease owner rebuilds; other instances wait for the cached result. */
@Injectable()
export class StampedeGuard {
  private readonly logger = new Logger(StampedeGuard.name);
  private readonly inFlightPromises = new Map<string, Promise<unknown>>();

  /** Shares one in-flight call per key within this process. */
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

  /** Acquires a Redis lease with a millisecond TTL. */
  async acquireLock(
    client: Redis,
    lockKey: string,
    ttlMs = 5000,
  ): Promise<StampedeLock> {
    const workerId = randomUUID();
    try {
      const res = await withLockCommandTimeout(
        client.set(lockKey, workerId, 'PX', ttlMs, 'NX'),
      );
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
      // On Redis errors, allow the database rebuild without a lease.
      return { lockKey, workerId, acquired: true };
    }
  }

  /** Releases the lease only if this worker still owns it. */
  async releaseLock(client: Redis, lock: StampedeLock): Promise<void> {
    if (!lock.acquired) return;
    try {
      await withLockCommandTimeout(
        client.eval(RELEASE_LOCK_LUA, 1, lock.lockKey, lock.workerId),
      );
    } catch (err: unknown) {
      this.logger.debug(
        `Failed to release stampede lock ${lock.lockKey}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  async isLocked(client: Redis, lockKey: string): Promise<boolean> {
    try {
      const exists = await withLockCommandTimeout(client.exists(lockKey));
      return exists === 1;
    } catch {
      return false;
    }
  }
}

