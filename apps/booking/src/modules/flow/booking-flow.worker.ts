import { randomUUID } from 'node:crypto';
import {
  Injectable,
  Logger,
  type OnApplicationShutdown,
  type OnModuleInit,
} from '@nestjs/common';

import { BookingFlowRepository } from './booking-flow.repository.js';
import { BookingConfirmationService } from './services/booking-confirmation.service.js';
import { BookingFlowService } from './services/booking-flow.service.js';

/** How often the worker looks for work. Each pass is bounded by the claim. */
const SCAN_INTERVAL_MS = 2_000;

/** A charge this old without a settlement outcome is worth a human's attention. */
const CHARGED_WITHOUT_OUTCOME_THRESHOLD_SECONDS = 60;

/**
 * Drives the flows nobody is waiting on: a step whose remote call failed, a
 * hold that ran out, and a compensation still owed.
 *
 * Every deadline lives in the database, so two instances agree without talking
 * to each other, and a restart loses nothing. The service holds no timer of
 * its own, the way HoldExpiryWorker keeps inventory's scans out of
 * HoldCoreService.
 */
@Injectable()
export class BookingFlowWorker implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger(BookingFlowWorker.name);
  private readonly workerId = randomUUID();
  private timer: NodeJS.Timeout | undefined;
  private scanning = false;

  constructor(
    private readonly repository: BookingFlowRepository,
    private readonly flow: BookingFlowService,
    private readonly confirmation: BookingConfirmationService,
  ) {}

  onModuleInit(): void {
    void this.scan();
    this.timer = setInterval(() => void this.scan(), SCAN_INTERVAL_MS);
    // A pending scan must never hold the process open.
    this.timer.unref();
  }

  onApplicationShutdown(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  /** One pass: expire what is due, resume what stalled, pay back what is owed. */
  async scan(): Promise<void> {
    if (this.scanning) return;
    this.scanning = true;
    try {
      await this.expireDue();
      await this.resumeStalled();
      await this.runCompensations();
      await this.logChargedWithoutOutcome();
    } catch (error: unknown) {
      this.logger.error(`Booking flow scan failed: ${messageOf(error)}`);
    } finally {
      this.scanning = false;
    }
  }

  private async expireDue(): Promise<void> {
    for (const id of await this.repository.expireAllDue()) {
      try {
        await this.flow.compensate(id);
      } catch (error: unknown) {
        this.logger.warn(
          `Booking ${id} expired but could not be settled yet: ${messageOf(error)}`,
        );
      }
    }
  }

  private async resumeStalled(): Promise<void> {
    for (const flow of await this.repository.claimResumable(this.workerId)) {
      try {
        if (flow.flowState === 'payment_starting') {
          await this.flow.startPayment(flow.id);
        } else if (
          flow.flowState === 'confirming' ||
          flow.flowState === 'refunding'
        ) {
          await this.confirmation.run(flow.id);
        } else {
          await this.flow.advance(flow.id);
        }
        await this.repository.releaseLease(flow.id, this.workerId);
      } catch (error: unknown) {
        // The step keeps its place; the next pass tries it again.
        if (flow.flowState === 'confirming' || flow.flowState === 'refunding') {
          const attempts = await this.repository.deferSaga(
            flow.id,
            this.workerId,
            messageOf(error),
          );
          if (attempts !== null && attempts >= 12) {
            await this.repository.deadLetterCompensation(
              flow.id,
              attempts,
              messageOf(error),
            );
            this.logger.error(
              `DEAD LETTER: saga for booking ${flow.id} failed ${attempts} times; retry continues`,
            );
          }
        } else {
          await this.repository.deferResume(
            flow.id,
            this.workerId,
            messageOf(error),
          );
        }
        this.logger.warn(
          `Booking ${flow.id} stays at ${flow.flowState}; the step will retry: ${messageOf(error)}`,
        );
      }
    }
  }

  /** Charged without a ticket or a refund: the anti-goal §2 forbids silently. */
  private async logChargedWithoutOutcome(): Promise<void> {
    const stuck = await this.repository.findChargedWithoutOutcome(
      CHARGED_WITHOUT_OUTCOME_THRESHOLD_SECONDS,
    );
    for (const { id, sagaStep } of stuck) {
      this.logger.error(
        `ALERT: booking ${id} was charged and is still ${sagaStep}`,
      );
    }
  }

  private async runCompensations(): Promise<void> {
    for (const id of await this.repository.claimCompensable(this.workerId)) {
      try {
        await this.flow.compensate(id);
      } finally {
        await this.repository.releaseLease(id, this.workerId);
      }
    }
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
