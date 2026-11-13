import {
  BeforeApplicationShutdown,
  Inject,
  Injectable,
  Logger,
  OnApplicationBootstrap,
} from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import { CORRELATION_ID_KEY } from '@app/common/correlation/correlation.constants.js';
import { OUTBOX_DEFAULTS } from '@app/common/config/env.defaults.js';
import {
  UNIT_OF_WORK,
  type UnitOfWorkPort,
} from '@app/common/persistence/unit-of-work.port.js';
import { SchemaReadinessGate } from '@app/common/persistence/schema-readiness.gate.js';
import type { EventEnvelope } from '@app/contracts';
import { envelopeOf, type OutboxRow } from './outbox-row.js';
import { relayBackoffMs } from './backoff.js';
import { TypeOrmOutboxRepository } from './typeorm-outbox.repository.js';
import { EventPublisherService } from '../publisher/event-publisher.service.js';

/**
 * In one transaction: claim with SKIP LOCKED, confirm publish, mark published, commit.
 * Catch publish failures inside it so retry counts and backoff still commit.
 */
@Injectable()
export class OutboxRelayService
  implements OnApplicationBootstrap, BeforeApplicationShutdown
{
  private readonly logger = new Logger(OutboxRelayService.name);
  private running: Promise<void> | null = null;
  private stopping = false;
  private timer: NodeJS.Timeout | null = null;
  private wake: (() => void) | null = null;

  constructor(
    @Inject(UNIT_OF_WORK) private readonly unitOfWork: UnitOfWorkPort,
    private readonly outbox: TypeOrmOutboxRepository,
    private readonly publisher: EventPublisherService,
    private readonly cls: ClsService,
    private readonly schema: SchemaReadinessGate,
  ) {}

  onApplicationBootstrap(): void {
    if (!this.isEnabled()) {
      this.logger.log('Outbox relay disabled by OUTBOX_RELAY_ENABLED');
      return;
    }
    this.running = this.loop();
  }

  /** Drain before Nest closes the AMQP channel in its final shutdown hook. */
  async beforeApplicationShutdown(): Promise<void> {
    this.stopping = true;
    this.wakeLoop();
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.running) {
      await this.running;
      this.running = null;
    }
  }

  /** Testable batch without timers. */
  async runOnce(): Promise<number> {
    let published = 0;

    await this.unitOfWork.withTransaction(async (ctx) => {
      const rows = await this.outbox.claimBatch(ctx, this.batchSize());

      for (const row of rows) {
        try {
          await this.publishRow(row);
          await this.outbox.markPublished(ctx, row.id);
          published += 1;
        } catch (error: unknown) {
          const message =
            error instanceof Error ? error.message : String(error);
          const nextAttemptAt = new Date(
            Date.now() + relayBackoffMs(row.attemptCount + 1),
          );
          await this.outbox.recordFailure(
            ctx,
            row.id,
            // Store the error message only, never the secret-bearing payload.
            message,
            nextAttemptAt,
          );
          this.logger.warn(
            `Outbox publish failed for ${row.id}; retrying at ${nextAttemptAt.toISOString()}: ${message}`,
          );
          break;
        }
      }
    });

    return published;
  }

  /** Restore the event's correlation ID so publishes stay on the original trace. */
  private async publishRow(row: OutboxRow): Promise<void> {
    const envelope: EventEnvelope = envelopeOf(row);
    await this.cls.run(async () => {
      this.cls.set(CORRELATION_ID_KEY, envelope.correlationId);
      await this.publisher.publishConfirmed(envelope);
    });
  }

  private async loop(): Promise<void> {
    // Wait for migrations to settle before claiming; failures also settle the gate.
    await this.schema.whenReady;

    while (!this.stopping) {
      try {
        await this.runOnce();
      } catch (error: unknown) {
        // Keep polling after temporary database failures.
        this.logger.error(
          `Outbox relay tick failed: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }

      if (this.stopping) break;
      await this.wait(this.pollIntervalMs());
    }
  }

  /**
   * Schedule one timeout at a time to avoid overlapping row claims.
   * Timers do not keep Node alive; wakeLoop interrupts the wait during shutdown.
   */
  private wait(ms: number): Promise<void> {
    return new Promise<void>((resolve) => {
      this.wake = () => {
        this.wake = null;
        resolve();
      };
      this.timer = setTimeout(() => {
        this.timer = null;
        this.wake = null;
        resolve();
      }, ms);
      this.timer.unref?.();
    });
  }

  private wakeLoop(): void {
    this.wake?.();
  }

  private isEnabled(): boolean {
    return (process.env.OUTBOX_RELAY_ENABLED ?? 'true') !== 'false';
  }

  private pollIntervalMs(): number {
    const raw = Number(process.env.OUTBOX_POLL_INTERVAL_MS);
    return Number.isFinite(raw) && raw > 0
      ? raw
      : OUTBOX_DEFAULTS.pollIntervalMs;
  }

  private batchSize(): number {
    const raw = Number(process.env.OUTBOX_BATCH_SIZE);
    return Number.isInteger(raw) && raw > 0 ? raw : OUTBOX_DEFAULTS.batchSize;
  }
}
