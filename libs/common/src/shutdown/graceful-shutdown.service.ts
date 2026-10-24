import {
  Injectable,
  OnApplicationShutdown,
  ServiceUnavailableException,
} from '@nestjs/common';
import { Logger } from '@nestjs/common';

@Injectable()
export class GracefulShutdownService implements OnApplicationShutdown {
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

  onApplicationShutdown(signal?: string): void {
    this.logger.log(
      `Received shutdown signal: ${signal || 'none'}; completing graceful shutdown`,
    );
    this.markShuttingDown();
  }
}
