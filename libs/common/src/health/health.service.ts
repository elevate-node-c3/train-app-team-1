import {
  Injectable,
  Logger,
  Optional,
  ServiceUnavailableException,
} from '@nestjs/common';
import { DataSource } from 'typeorm';
import { AmqpClientService } from '@app/messaging';
import {
  HealthState,
  ServiceDependencyHealth,
  ServiceHealthReport,
} from '@app/contracts';
import { GracefulShutdownService } from '../shutdown/graceful-shutdown.service.js';
import { DataSourceInitializer } from '../persistence/data-source-initializer.js';
import { RedisHealthService } from './redis-health.service.js';

@Injectable()
export class HealthService {
  private readonly logger = new Logger(HealthService.name);

  constructor(
    private readonly shutdownService: GracefulShutdownService,
    private readonly redisHealth: RedisHealthService,
    @Optional() private readonly dataSource?: DataSource,
    @Optional() private readonly amqpClient?: AmqpClientService,
    @Optional() private readonly initializer?: DataSourceInitializer,
  ) {}

  checkLiveness(): { status: 'live'; timestamp: string } {
    this.shutdownService.assertAcceptingRequests();
    return {
      status: 'live',
      timestamp: new Date().toISOString(),
    };
  }

  async checkReadiness(serviceName?: string): Promise<ServiceHealthReport> {
    this.shutdownService.assertAcceptingRequests();

    const currentService = serviceName || process.env.APP || 'unknown';
    const dependencies: Record<string, ServiceDependencyHealth> = {};
    let isFullyReady = true;
    let isDegraded = false;

    // 1. Check PostgreSQL Database
    if (this.dataSource) {
      try {
        // Through the shared initializer, not `dataSource.initialize()`
        // directly: a readiness probe arriving while a use-case is opening the
        // same DataSource would otherwise race it and throw
        // CannotConnectAlreadyConnectedError, reporting a healthy database as
        // not ready.
        if (this.initializer) {
          await this.initializer.ensureInitialized();
        } else if (!this.dataSource.isInitialized) {
          await this.dataSource.initialize();
        }
        const queryPromise = this.dataSource.query('SELECT 1');
        const timeoutPromise = new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('Database query timed out')), 2000),
        );
        await Promise.race([queryPromise, timeoutPromise]);
        dependencies.database = { status: 'ready' };
      } catch (err: unknown) {
        isFullyReady = false;
        const msg = err instanceof Error ? err.message : String(err);
        dependencies.database = { status: 'not_ready', message: msg };
        this.logger.warn(`Postgres check failed for ${currentService}: ${msg}`);
      }
    }

    // 2. Check RabbitMQ Broker
    if (this.amqpClient) {
      const amqpHealth = await this.amqpClient.checkHealth();
      if (amqpHealth.status === 'ready') {
        dependencies.broker = { status: 'ready' };
      } else {
        isFullyReady = false;
        dependencies.broker = {
          status: 'not_ready',
          message: amqpHealth.message,
        };
        this.logger.warn(
          `RabbitMQ check failed for ${currentService}: ${amqpHealth.message}`,
        );
      }
    }

    // 3. Check Redis Cache (Degraded, not dead per §2.3 rule 7)
    const redisResult = await this.redisHealth.check();
    if (redisResult.status === 'ready') {
      dependencies.redis = { status: 'ready' };
    } else {
      isDegraded = true;
      dependencies.redis = {
        status: 'degraded',
        message:
          redisResult.message ||
          'Redis is unavailable; running in degraded cache mode',
      };
      this.logger.warn(
        `Redis is unavailable for ${currentService}; proceeding in degraded mode.`,
      );
    }

    let status: HealthState = 'ready';
    if (!isFullyReady) {
      status = 'not_ready';
    } else if (isDegraded) {
      status = 'degraded';
    }

    const report: ServiceHealthReport = {
      service: currentService,
      status,
      dependencies,
      timestamp: new Date().toISOString(),
    };

    if (status === 'not_ready') {
      throw new ServiceUnavailableException({
        message: 'Service dependencies are not ready',
        data: report,
      });
    }

    return report;
  }
}
