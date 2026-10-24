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
import type { EventEnvelope } from '@app/contracts';
import { envelopeOf, type OutboxRow } from './outbox-row.js';
import { relayBackoffMs } from './backoff.js';
import { TypeOrmOutboxRepository } from './typeorm-outbox.repository.js';
import { EventPublisherService } from '../publisher/event-publisher.service.js';

/**
 * Polls the outbox and publishes committed rows.
 *
 * The whole point is the ordering inside one transaction:
 *
 *   claim (FOR UPDATE SKIP LOCKED)
 *     -> publish and wait for the broker confirm
 *       -> mark published
 *         -> commit (releasing the row lock)
 *
 * A publish rejection is caught *inside* the transaction callback. Letting it
 * escape would roll back the failure bookkeeping as well, so the same row would
 * be claimed at full speed forever. Committing the failure — with a backoff —
 * is what makes a broker outage a queue rather than a hot loop.
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
  ) {}

  onApplicationBootstrap(): void {
    if (!this.isEnabled()) {
      this.logger.log('Outbox relay disabled by OUTBOX_RELAY_ENABLED');
      return;
    }
    this.running = this.loop();
  }

  /**
   * Drains in `beforeApplicationShutdown`, while `AmqpClientService` still
   * holds the channel. `onApplicationShutdown` runs after dispose, too late to
   * publish anything.
   */
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

  /** One batch. Public so tests can drive it without timers. */
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
            // `message` only. The payload can contain a live code and must
            // never reach a column operators read.
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

  /**
   * The relay has no HTTP request, so CLS is empty on its own. Restoring the
   * envelope's correlation id is what puts the publish on the same trace as
   * the sign-up that wrote the row.
   */
  private async publishRow(row: OutboxRow): Promise<void> {
    const envelope: EventEnvelope = envelopeOf(row);
    await this.cls.run(async () => {
      this.cls.set(CORRELATION_ID_KEY, envelope.correlationId);
      await this.publisher.publishConfirmed(envelope);
    });
  }

  private async loop(): Promise<void> {
    while (!this.stopping) {
      try {
        await this.runOnce();
      } catch (error: unknown) {
        // A Postgres blip must not kill the loop: the next tick retries.
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
   * A self-rescheduling timeout, never `setInterval`: overlapping ticks would
   * make one process contend with itself for the same rows. The timer is
   * unref'd so it does not keep the process alive; `wakeLoop` makes shutdown
   * immediate rather than waiting out a poll interval.
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
