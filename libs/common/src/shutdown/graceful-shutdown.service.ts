import {
  Injectable,
  Logger,
  OnModuleDestroy,
  ServiceUnavailableException,
} from '@nestjs/common';

/**
 * Marks draining in onModuleDestroy, before Nest closes the HTTP server.
 * Readiness must reject new traffic then; onApplicationShutdown is too late.
 */
@Injectable()
export class GracefulShutdownService implements OnModuleDestroy {
  private readonly logger = new Logger(GracefulShutdownService.name);
  private isShuttingDown = false;

  markShuttingDown(): void {
    if (!this.isShuttingDown) {
      this.isShuttingDown = true;
      this.logger.warn(
        'Service has entered graceful shutdown mode; rejecting new traffic',
      );
    }
  }

  isAcceptingRequests(): boolean {
    return !this.isShuttingDown;
  }

  assertAcceptingRequests(): void {
    if (this.isShuttingDown) {
      throw new ServiceUnavailableException('Service is shutting down');
    }
  }

  onModuleDestroy(): void {
    this.logger.log('Received shutdown signal; completing graceful shutdown');
    this.markShuttingDown();
  }
}
