import { Global, Module } from '@nestjs/common';
import { CacheAsideService } from './cache-aside.service.js';
import { CacheMetrics } from './cache-metrics.js';
import { REDIS_CLIENT, RedisClientService } from './redis-client.service.js';
import { StampedeGuard } from './stampede-guard.js';

// Shares one Redis connection and cache service across all modules.
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
