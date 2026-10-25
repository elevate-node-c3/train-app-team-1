import { Global, Module } from '@nestjs/common';
import { REDIS_CLIENT, RedisClientService } from './redis-client.service.js';

/**
 * Exactly one Redis client per process, available to every module that needs
 * it without each one constructing another connection.
 */
@Global()
@Module({
  providers: [
    RedisClientService,
    { provide: REDIS_CLIENT, useExisting: RedisClientService },
  ],
  exports: [RedisClientService, REDIS_CLIENT],
})
export class RedisModule {}
