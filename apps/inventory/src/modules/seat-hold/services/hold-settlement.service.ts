import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';

import {
  ErrorCode,
  type SettleHoldRequest,
  type SettlementOutcome,
  type SettlementSnapshot,
} from '@app/contracts';
import { UNIT_OF_WORK } from '@app/common/persistence/unit-of-work.port.js';
import type {
  TransactionContext,
  UnitOfWorkPort,
} from '@app/common/persistence/unit-of-work.port.js';

import { HoldCoreError } from '../hold-core.errors.js';
import { HoldCoreRepository, type LegFacts } from '../hold-core.repository.js';
import {
  AvailabilityPublisher,
  WHOLE_TRIP,
} from '../../seats/services/availability-publisher.service.js';

/**
 * BR-36: converts a hold into a real sale once its payment has settled. A
 * live hold sells exactly what it holds; an expired-but-free hold re-sells
 * the same seats; a taken hold reallocates within the same class; a full
 * class refuses rather than occupying nothing. One decision per leg union,
 * never a partial sale across legs.
 */
@Injectable()
export class HoldSettlementService {
  constructor(
    private readonly repository: HoldCoreRepository,
    @Inject(UNIT_OF_WORK) private readonly unitOfWork: UnitOfWorkPort,
    private readonly availability: AvailabilityPublisher,
  ) {}

  async settle(
    request: SettleHoldRequest,
    correlationId: string = randomUUID(),
  ): Promise<SettlementSnapshot> {
    return this.unitOfWork.withTransaction(async (ctx) => {
      const hold = await this.repository.lockHoldByKey(ctx, request.bookingKey);
      if (!hold || hold.ownerId !== request.ownerId) {
        throw new HoldCoreError(
          ErrorCode.HOLD_NOT_FOUND,
          'No hold exists for this booking key.',
        );
      }

      const tripIds = await this.repository.legTripIds(ctx, hold.id);
      await this.repository.lockTrips(ctx, tripIds);
      const now = await this.repository.sampleNow(ctx);

      if (hold.settlementOutcome !== null) {
        return this.buildSnapshot(ctx, hold.id, hold.settlementOutcome, now);
      }

      await this.repository.reclaimExpiredOccupations(ctx, tripIds, now);

      const legInputs = await this.repository.loadLegInputs(ctx, hold.id);
      const facts = await this.resolveFactsOrNull(ctx, legInputs);

      let outcome: SettlementOutcome;

      if (
        hold.state === 'cancelled' ||
        facts === null ||
        !(await this.repository.hasCompleteSettlementReceipt(ctx, hold.id))
      ) {
        outcome = 'NO_SEATS';
      } else {
        outcome = await this.repository.attemptSettlement(ctx, async () => {
          if (await this.repository.hasLiveOccupations(ctx, hold.id)) {
            if (
              !(await this.repository.hasCompleteLiveOccupations(ctx, hold.id))
            ) {
              return 'NO_SEATS';
            }
            await this.repository.sellHold(ctx, hold.id, now);
            return 'SOLD';
          }
          if (
            !(await this.repository.passengersClearForSettlement(
              ctx,
              hold.id,
              facts,
              now,
            ))
          ) {
            return 'NO_SEATS';
          }
          if (
            await this.repository.reacquireSameSeats(
              ctx,
              hold.id,
              hold.ownerId,
              facts,
              now,
            )
          ) {
            return 'SOLD';
          }
          if (
            await this.repository.reallocateForBooking(
              ctx,
              hold.id,
              hold.ownerId,
              facts,
              now,
            )
          ) {
            return 'REALLOCATED';
          }
          return 'NO_SEATS';
        });
      }

      if (outcome === 'NO_SEATS') {
        await this.repository.recordNoSeats(ctx, hold.id, now);
      }
      for (const tripId of tripIds) {
        await this.availability.publishChange(
          ctx,
          tripId,
          WHOLE_TRIP,
          correlationId,
          now,
        );
      }

      return this.buildSnapshot(ctx, hold.id, outcome, now);
    });
  }

  /** A closed trip or a missing stop refuses settlement rather than throwing. */
  private async resolveFactsOrNull(
    ctx: TransactionContext,
    legInputs: Parameters<HoldCoreRepository['resolveLegFacts']>[1],
  ): Promise<LegFacts[] | null> {
    try {
      return await this.repository.resolveLegFacts(ctx, legInputs);
    } catch (error) {
      if (error instanceof HoldCoreError) return null;
      throw error;
    }
  }

  private async buildSnapshot(
    ctx: TransactionContext,
    holdId: string,
    outcome: SettlementOutcome,
    now: Date,
  ): Promise<SettlementSnapshot> {
    const { legs, assignments } = await this.repository.loadSettlement(
      ctx,
      holdId,
    );
    return {
      outcome,
      holdId,
      legs,
      assignments,
      serverNow: now.toISOString(),
    };
  }
}
