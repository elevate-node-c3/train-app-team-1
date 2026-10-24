import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { Redis } from 'ioredis';

@Injectable()
export class RedisHealthService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RedisHealthService.name);
  private client: Redis | null = null;
  private isConnected = false;

  async onModuleInit(): Promise<void> {
    const url = process.env.REDIS_URL;
    if (!url) {
      return;
    }

    try {
      this.client = new Redis(url, {
        lazyConnect: true,
        maxRetriesPerRequest: null,
        enableOfflineQueue: false,
        retryStrategy: (times: number) => Math.min(times * 500, 3000),
      });

      this.client.on('connect', () => {
        this.isConnected = true;
      });

      this.client.on('ready', () => {
        this.isConnected = true;
      });

      this.client.on('error', (err) => {
        this.isConnected = false;
        this.logger.warn(
          `Redis connection error: ${err.message}. Operating in degraded cache mode.`,
        );
      });

      this.client.on('close', () => {
        this.isConnected = false;
      });

      // Attempt initial connection without blocking service boot
      await this.client.connect().catch(() => {
        this.logger.warn(
          'Redis is unavailable at boot; service continues in degraded mode (§2.3 rule 7).',
        );
      });
    } catch (err: unknown) {
      this.logger.warn(
        `Failed to initialize Redis client: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  async check(): Promise<{
    status: 'ready' | 'unavailable';
    message?: string;
  }> {
    if (!this.client) {
      return { status: 'unavailable', message: 'Redis client not configured' };
    }

    try {
      // 1-second timeout for ping
      const pingPromise = this.client.ping();
      const timeoutPromise = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('Redis ping timed out')), 1000),
      );

      const res = await Promise.race([pingPromise, timeoutPromise]);
      if (res === 'PONG') {
        return { status: 'ready' };
      }
      return { status: 'unavailable', message: 'Unexpected ping response' };
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      return { status: 'unavailable', message: errMsg };
    }
  }

  async onModuleDestroy(): Promise<void> {
    if (this.client) {
      try {
        await this.client.quit().catch(() => {});
      } catch {
        // Ignore shutdown errors
      }
      this.client = null;
    }
  }
}
