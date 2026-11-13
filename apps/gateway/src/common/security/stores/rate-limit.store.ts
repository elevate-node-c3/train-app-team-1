import { Injectable, Logger } from '@nestjs/common';
import { RedisClientService } from '@app/common';

export interface RateLimitHit {
  count: number;
  /** True when the shared Redis window could not be used. */
  degraded: boolean;
}

interface MemoryWindow {
  count: number;
  resetAt: number;
}

const RATE_PREFIX = 'auth:rate:';

/**
 * Shared Redis counters fall back to local counters during outages.
 * Local limits multiply across instances, so the guard halves them.
 * Readiness reports the outage; sign-in remains throttled.
 */
@Injectable()
export class RateLimitStore {
  private readonly logger = new Logger(RateLimitStore.name);
  private readonly memory = new Map<string, MemoryWindow>();

  constructor(private readonly redis: RedisClientService) {}

  async increment(key: string, windowSeconds: number): Promise<RateLimitHit> {
    const now = Date.now();
    this.prune(now);

    const client = this.redis.isAvailable() ? this.redis.getClient() : null;
    if (!client) {
      return {
        count: this.memoryIncrement(key, now, windowSeconds),
        degraded: true,
      };
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
