import { randomUUID } from 'node:crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import type {
  EventEnvelope,
  TripPublishedPayloadV1,
  TripWithdrawnPayloadV1,
} from '@app/contracts';
import { TRIP_PUBLISHED_EVENT_TYPE, TRIP_WITHDRAWN_EVENT_TYPE } from '@app/contracts';
import {
  OUTBOX,
  PermanentEventError,
  type EventHandlerPort,
  type EventHandlingResult,
  type OutboxPort,
} from '@app/messaging';
import { UNIT_OF_WORK } from '@app/common/persistence/unit-of-work.port.js';
import type {
  TransactionContext,
  UnitOfWorkPort,
} from '@app/common/persistence/unit-of-work.port.js';

import {
  buildTripPublicationRefused,
  buildTripSeatsCreated,
} from '../seats/inventory-events.factory.js';
import { verdictFor } from '../seats/publication-validation.js';
import { seatPlanFrom } from '../seats/seat-plan.js';
import type { SeatPlan } from '../seats/seat-plan.js';
import { SeatPlanRepository } from '../seats/seat-plan.repository.js';
import type { ApplyOutcome } from '../seats/seat-plan.repository.js';

/** Turns `catalog.trip.published` into committed seats; closes withdrawn trips. */
@Injectable()
export class TripLifecycleConsumer implements EventHandlerPort {
  private readonly logger = new Logger(TripLifecycleConsumer.name);

  constructor(
    private readonly repository: SeatPlanRepository,
    @Inject(UNIT_OF_WORK) private readonly unitOfWork: UnitOfWorkPort,
    @Inject(OUTBOX) private readonly outbox: OutboxPort,
  ) {}

  async handle(envelope: EventEnvelope): Promise<EventHandlingResult> {
    switch (envelope.type) {
      case TRIP_PUBLISHED_EVENT_TYPE:
        return this.handlePublished(
          envelope as EventEnvelope<string, TripPublishedPayloadV1>,
        );
      case TRIP_WITHDRAWN_EVENT_TYPE:
        return this.handleWithdrawn(
          envelope as EventEnvelope<string, TripWithdrawnPayloadV1>,
        );
      default:
        return { status: 'skipped', skipReason: 'unrecognized_event_type' };
    }
  }

  private async handlePublished(
    envelope: EventEnvelope<string, TripPublishedPayloadV1>,
  ): Promise<EventHandlingResult> {
    const payload = envelope.payload;

    // Check usability before opening any transaction (spec §6.4): an
    // incomplete publication must never start one, and a malformed one
    // dead-letters without ever touching the database.
    const verdict = verdictFor(payload);
    if (verdict.kind === 'incomplete') {
      // Catalog may still be mid-generation; the platform retries with backoff.
      throw new Error(`Trip publication incomplete: ${verdict.reason}`);
    }
    if (verdict.kind === 'malformed') {
      // Retrying cannot help broken data; dead-letter immediately.
      throw new PermanentEventError(
        `Trip publication malformed: ${verdict.reason}`,
        'invalid-payload',
      );
    }

    const plan = seatPlanFrom(payload);

    if (plan.capacityMismatch !== null) {
      // The layout is the truth; refusing over a cosmetic summary field
      // would stop a whole day's trips going on sale (spec §6.10).
      this.logger.warn(
        `Trip ${plan.tripId} capacity mismatch: catalog reported ${plan.capacityMismatch}`,
      );
    }

    const outcome = await this.unitOfWork.withTransaction((ctx) =>
      this.applyAndPublish(ctx, plan, envelope.correlationId),
    );

    if (outcome.kind === 'created') {
      return { status: 'handled' };
    }
    if (outcome.kind === 'skipped') {
      return { status: 'skipped', skipReason: outcome.reason };
    }

    // A refusal cannot be published from the transaction that rolled it back
    // out of existence, so commit it separately before dead-lettering. The
    // two commits are not atomic (spec §6.5): a crash between them loses the
    // dead-lettering but keeps the refusal event, which is the safer loss.
    await this.unitOfWork.withTransaction((ctx) =>
      this.outbox.append(
        ctx,
        buildTripPublicationRefused({
          eventId: randomUUID(),
          correlationId: envelope.correlationId,
          occurredAt: new Date(),
          payload: {
            tripId: plan.tripId,
            timetableVersion: plan.timetableVersion,
            reason: 'occupied seats would be dropped by the new layout',
            occupiedSeatNumbers: outcome.occupiedSeatNumbers,
            occupiedStationIds: outcome.occupiedStationIds,
          },
        }),
      ),
    );

    throw new PermanentEventError(
      'Trip publication refused: occupied seats would be dropped',
      'invalid-payload',
    );
  }

  private async applyAndPublish(
    ctx: TransactionContext,
    plan: SeatPlan,
    correlationId: string,
  ): Promise<ApplyOutcome> {
    const outcome = await this.repository.apply(ctx, plan);
    if (outcome.kind === 'created') {
      await this.outbox.append(
        ctx,
        buildTripSeatsCreated({
          eventId: randomUUID(),
          correlationId,
          occurredAt: new Date(),
          payload: {
            tripId: plan.tripId,
            serviceDate: plan.serviceDate,
            timetableVersion: plan.timetableVersion,
            seatCountByClass: Object.entries(outcome.seatCountByClass).map(
              ([travelClassId, seatCount]) => ({ travelClassId, seatCount }),
            ),
          },
        }),
      );
    }
    return outcome;
  }

  private async handleWithdrawn(
    envelope: EventEnvelope<string, TripWithdrawnPayloadV1>,
  ): Promise<EventHandlingResult> {
    // Touches no occupation: existing holds and sold tickets survive for the
    // refund flow.
    await this.unitOfWork.withTransaction((ctx) =>
      this.repository.close(ctx, envelope.payload.tripId),
    );
    return { status: 'handled' };
  }
}
