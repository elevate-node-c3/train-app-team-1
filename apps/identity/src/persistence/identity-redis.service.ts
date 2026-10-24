import {
  HttpStatus,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { Redis } from 'ioredis';
import { DomainException } from '@app/common';
import { ErrorCode } from '@app/contracts';

/** Upper bound on any single Redis command before it counts as unavailable. */
const COMMAND_TIMEOUT_MS = 1000;

/**
 * Redis client for the sign-in lockout. It fails closed: if Redis cannot
 * answer, `run` throws a 503, so an outage never means unlimited attempts.
 */
@Injectable()
export class IdentityRedisService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(IdentityRedisService.name);
  private client: Redis | null = null;

  /**
   * Connects to REDIS_URL without blocking boot.
   * @returns resolves once connected, or once the first attempt has failed
   */
  async onModuleInit(): Promise<void> {
    const url = process.env.REDIS_URL;
    if (!url) {
      return;
    }

    this.client = new Redis(url, {
      lazyConnect: true,
      enableOfflineQueue: false,
      maxRetriesPerRequest: 0,
      commandTimeout: COMMAND_TIMEOUT_MS,
      retryStrategy: (times: number) => Math.min(times * 500, 3000),
    });

    this.client.on('error', (err) => {
      this.logger.warn(
        `Redis connection error: ${err.message}. Security operations will fail closed.`,
      );
    });

    // Boot is not blocked; each operation fails closed until Redis is back.
    await this.client.connect().catch(() => {
      this.logger.warn(
        'Redis is unavailable at boot; security operations will fail closed.',
      );
    });
  }

  /**
   * Runs `operation` against Redis. Any failure becomes a 503
   * SERVICE_UNAVAILABLE.
   * @returns whatever `operation` returns
   */
  async run<T>(operation: (client: Redis) => Promise<T>): Promise<T> {
    if (!this.client) {
      throw this.unavailable();
    }
    try {
      return await operation(this.client);
    } catch (err: unknown) {
      this.logger.error(
        `Redis operation failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      throw this.unavailable();
    }
  }

  /**
   * Closes the connection on shutdown.
   * @returns resolves once the client has quit
   */
  async onModuleDestroy(): Promise<void> {
    if (this.client) {
      await this.client.quit().catch(() => {});
      this.client = null;
    }
  }

  /** @returns a SERVICE_UNAVAILABLE (503) exception */
  private unavailable(): DomainException {
    return new DomainException(
      ErrorCode.SERVICE_UNAVAILABLE,
      HttpStatus.SERVICE_UNAVAILABLE,
    );
  }
}
