import {
  BeforeApplicationShutdown,
  Injectable,
  Logger,
  OnApplicationBootstrap,
} from '@nestjs/common';
import { MigrationRunnerService, SchemaReadinessGate } from '@app/common';
import {
  holdExpiryBatchSize,
  holdExpiryPollIntervalMs,
  holdExpiryWorkerEnabled,
} from '../../config/hold-settings.js';
import { HoldCoreService } from './hold-core.service.js';

@Injectable()
export class HoldExpiryWorker
  implements OnApplicationBootstrap, BeforeApplicationShutdown
{
  private readonly logger = new Logger(HoldExpiryWorker.name);
  private stopping = false;
  private running: Promise<void> | null = null;
  private timer: NodeJS.Timeout | null = null;
  private wake: (() => void) | null = null;
  private stopWaiting: () => void = () => {};
  private readonly stopped = new Promise<void>((resolve) => {
    this.stopWaiting = resolve;
  });

  constructor(
    private readonly holds: HoldCoreService,
    private readonly schema: SchemaReadinessGate,
    private readonly migrations: MigrationRunnerService,
  ) {}

  onApplicationBootstrap(): void {
    if (!holdExpiryWorkerEnabled()) return;
    this.running ??= this.loop();
  }

  async beforeApplicationShutdown(): Promise<void> {
    this.stopping = true;
    this.stopWaiting();
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.wake?.();
    await this.running;
    this.running = null;
  }

  /** Useful for tests and operations; no broker or cached availability is used. */
  async runOnce(): Promise<number> {
    return this.holds.expireDueHolds(holdExpiryBatchSize());
  }

  private async loop(): Promise<void> {
    await Promise.race([this.schema.whenReady, this.stopped]);
    if (this.stopping) return;
    if (!this.migrations.hasCompleted) {
      this.logger.error(
        'Hold expiry did not start because migrations did not succeed.',
      );
      return;
    }

    // Every scan starts from persisted deadlines, including after an outage.
    while (!this.stopping) {
      try {
        if ((await this.runOnce()) > 0) continue;
      } catch (error: unknown) {
        // Never put SQL details or passenger identity values into worker logs.
        this.logger.error(
          `Hold expiry batch failed: ${error instanceof Error ? error.name : 'unknown'}`,
        );
      }

      if (this.stopping) break;
      await this.wait();
    }
  }

  /** This idle wake-up schedules a scan, never an individual hold's expiry. */
  private wait(): Promise<void> {
    const interval = holdExpiryPollIntervalMs();
    return new Promise<void>((resolve) => {
      this.wake = () => {
        this.wake = null;
        resolve();
      };
      this.timer = setTimeout(() => {
        this.timer = null;
        this.wake = null;
        resolve();
      }, interval);
      this.timer.unref?.();
    });
  }
}
