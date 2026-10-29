import { Injectable } from '@nestjs/common';
import { RedisClientService } from '../cache/redis-client.service.js';

/**
 * Health-view adapter over the process's shared client. Kept as a separate
 * provider because `HealthService` treats Redis specially: it is the one
 * dependency the platform deliberately degrades around rather than fails on.
 */
@Injectable()
export class RedisHealthService {
  constructor(private readonly redis: RedisClientService) {}

  async check(): Promise<{
    status: 'ready' | 'unavailable';
    message?: string;
  }> {
    const result = await this.redis.check();
    return result.ready
      ? { status: 'ready' }
      : { status: 'unavailable', message: result.message };
  }

  isAvailable(): boolean {
    return this.redis.isAvailable();
  }
}
