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
  private outageLogged = false;
  private readonly listeners = new Set<(available: boolean) => void>();

  /** Register a callback for Redis connection state changes. Returns an unsubscribe function. */
  onAvailabilityChange(listener: (available: boolean) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private notifyListeners(): void {
    const available = this.isAvailable();
    for (const listener of this.listeners) {
      try {
        listener(available);
      } catch (err: unknown) {
        this.logger.debug(
          `Availability listener threw: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }

  handleConnectionReady(): void {
    const wasConnected = this.connected;
    this.connected = true;
    if (this.outageLogged) {
      this.logger.log(
        'Redis connection restored; operating in normal cache mode.',
      );
      this.outageLogged = false;
    }
    if (!wasConnected) {
      this.notifyListeners();
    }
  }

  handleConnectionError(error?: Error): void {
    const wasConnected = this.connected;
    this.connected = false;

    // Log the outage ONCE rather than once per request or duplicate error (§2.3 rule 7)
    if (!this.outageLogged) {
      const reason = error?.message ? `: ${error.message}` : '';
      this.logger.warn(
        `Redis connection error${reason}. Operating in degraded cache mode (§2.3 rule 7).`,
      );
      this.outageLogged = true;
    }

    if (wasConnected) {
      this.notifyListeners();
    }
  }

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
        this.handleConnectionReady();
      });
      this.client.on('error', (error) => {
        this.handleConnectionError(error);
      });
      this.client.on('close', () => {
        this.handleConnectionError();
      });

      // Boot must not block on Redis: the platform degrades around it.
      await this.client.connect().catch(() => {
        this.handleConnectionError(
          new Error('Redis is unavailable at boot; service continues in degraded mode (§2.3 rule 7).'),
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
    if (!this.client || !this.connected) {
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
