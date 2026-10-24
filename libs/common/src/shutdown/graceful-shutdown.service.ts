import {
  Injectable,
  Logger,
  OnModuleDestroy,
  ServiceUnavailableException,
} from '@nestjs/common';

/**
 * Marks the process as draining at the *start* of Nest's shutdown sequence.
 *
 * `onModuleDestroy` is step 1. `onApplicationShutdown` is step 4 — after
 * `app.dispose()` has already closed the HTTP server — so flipping the flag
 * there would claim "stop taking new work" only once no new work can arrive.
 * Readiness checks consult this flag, so it must turn false before traffic is
 * drained, not after.
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
