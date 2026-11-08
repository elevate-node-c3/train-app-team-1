import { Global, Module } from '@nestjs/common';
import { CacheAsideService } from './cache-aside.service.js';
import { CacheMetrics } from './cache-metrics.js';
import { REDIS_CLIENT, RedisClientService } from './redis-client.service.js';
import { StampedeGuard } from './stampede-guard.js';

/**
 * Exactly one Redis client per process, available to every module that needs
 * it without each one constructing another connection.
 *
 * `CacheAsideService` rides along: it is a thin read-through seam over the same
 * client, and providing it here means a caller injects caching without also
 * taking a dependency on ioredis.
 */
@Global()
@Module({
  providers: [
    RedisClientService,
    { provide: REDIS_CLIENT, useExisting: RedisClientService },
    CacheMetrics,
    StampedeGuard,
    CacheAsideService,
  ],
  exports: [
    RedisClientService,
    REDIS_CLIENT,
    CacheMetrics,
    StampedeGuard,
    CacheAsideService,
  ],
})
export class RedisModule {}
