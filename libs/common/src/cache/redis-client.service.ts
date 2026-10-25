import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { Redis } from 'ioredis';
import type { DependencyHealthContributor } from '../health/dependency-health.js';

export const REDIS_CLIENT = Symbol('REDIS_CLIENT');

/**
 * The process's one Redis connection.
 *
 * Before this service existed every consumer of Redis built its own client, so
 * "the Redis client" was whichever module happened to be asked. One client
 * means one reconnect policy, one place to observe availability and one
 * dependency to report on readiness.
 */
@Injectable()
export class RedisClientService
  implements
    OnModuleInit,
    OnModuleDestroy,
    DependencyHealthContributor
{
  readonly name = 'redis';

  private readonly logger = new Logger(RedisClientService.name);
  private client: Redis | null = null;
  private connected = false;
  private configured = false;

  async onModuleInit(): Promise<void> {
    const url = process.env.REDIS_URL;
    if (!url) {
      this.logger.warn('REDIS_URL is not set; running in degraded cache mode');
      return;
    }

    this.configured = true;
    try {
      this.client = new Redis(url, {
        lazyConnect: true,
        maxRetriesPerRequest: 1,
        enableOfflineQueue: false,
        retryStrategy: (times: number) => Math.min(times * 500, 3000),
      });

      this.client.on('connect', () => {
        this.connected = true;
      });
      this.client.on('ready', () => {
        this.connected = true;
      });
      this.client.on('error', (error) => {
        this.connected = false;
        this.logger.warn(
          `Redis connection error: ${error.message}. Operating in degraded cache mode.`,
        );
      });
      this.client.on('close', () => {
        this.connected = false;
      });

      // Boot must not block on Redis: the platform degrades around it.
      await this.client.connect().catch(() => {
        this.logger.warn(
          'Redis is unavailable at boot; service continues in degraded mode (§2.3 rule 7).',
        );
      });
    } catch (error: unknown) {
      this.logger.warn(
        `Failed to initialize Redis client: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  /** True only when the socket is currently usable. Never a ping. */
  isAvailable(): boolean {
    return this.configured && this.connected && this.client !== null;
  }

  /** The shared client, or null when Redis was never configured. */
  getClient(): Redis | null {
    return this.client;
  }

  async check(): Promise<{ ready: boolean; message?: string }> {
    if (!this.client) {
      return {
        ready: false,
        message: this.configured
          ? 'Redis client unavailable'
          : 'Redis client not configured',
      };
    }

    try {
      const response = await Promise.race([
        this.client.ping(),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('Redis ping timed out')), 1000),
        ),
      ]);
      return response === 'PONG'
        ? { ready: true }
        : { ready: false, message: 'Unexpected ping response' };
    } catch (error: unknown) {
      return {
        ready: false,
        message: error instanceof Error ? error.message : String(error),
      };
    }
  }

  async onModuleDestroy(): Promise<void> {
    if (!this.client) return;
    try {
      await this.client.quit().catch(() => {});
    } finally {
      this.client = null;
      this.connected = false;
    }
  }
}
