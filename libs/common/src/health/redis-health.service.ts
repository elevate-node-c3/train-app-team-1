import { Injectable } from '@nestjs/common';
import { RedisClientService } from '../cache/redis-client.service.js';

/** Shared Redis health adapter; outages degrade rather than fail readiness. */
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
