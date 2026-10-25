import { Injectable, Logger } from '@nestjs/common';
import { RedisClientService } from '@app/common';
import type {
  RateLimitHit,
  RateLimitStorePort,
} from '../../application/ports/rate-limit-store.port.js';

interface MemoryWindow {
  count: number;
  resetAt: number;
}

const RATE_PREFIX = 'auth:rate:';

/**
 * Fixed-window counters, shared through Redis when it is healthy.
 *
 * A Redis outage falls back to a per-process window. That is weaker than one
 * shared counter (an attacker can multiply the budget by the instance count),
 * so the caller halves the limit in degraded mode and the readiness report
 * says the cache is down. The window is still enforced — a cache failure must
 * not turn sign-in into an unthrottled endpoint.
 */
@Injectable()
export class RateLimitStore implements RateLimitStorePort {
  private readonly logger = new Logger(RateLimitStore.name);
  private readonly memory = new Map<string, MemoryWindow>();

  constructor(private readonly redis: RedisClientService) {}

  async increment(key: string, windowSeconds: number): Promise<RateLimitHit> {
    const now = Date.now();
    this.prune(now);

    const client = this.redis.isAvailable() ? this.redis.getClient() : null;
    if (!client) {
      return { count: this.memoryIncrement(key, now, windowSeconds), degraded: true };
    }

    try {
      const redisKey = `${RATE_PREFIX}${key}`;
      const count = await client.incr(redisKey);
      if (count === 1) {
        await client.expire(redisKey, windowSeconds);
      }
      return { count, degraded: false };
    } catch (error: unknown) {
      this.logger.warn(
        `Rate-limit counter failed; using the in-process window: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return {
        count: this.memoryIncrement(key, now, windowSeconds),
        degraded: true,
      };
    }
  }

  private memoryIncrement(
    key: string,
    now: number,
    windowSeconds: number,
  ): number {
    const existing = this.memory.get(key);
    if (!existing || existing.resetAt <= now) {
      this.memory.set(key, {
        count: 1,
        resetAt: now + windowSeconds * 1000,
      });
      return 1;
    }
    existing.count += 1;
    return existing.count;
  }

  private prune(now: number): void {
    for (const [key, window] of this.memory) {
      if (window.resetAt <= now) this.memory.delete(key);
    }
  }
}
