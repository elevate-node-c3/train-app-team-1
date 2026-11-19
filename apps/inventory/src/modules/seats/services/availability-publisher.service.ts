import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { OUTBOX, type OutboxPort } from '@app/messaging';
import type { TransactionContext } from '@app/common/persistence/unit-of-work.port.js';

import { AvailabilityCountsRepository } from '../repositories/availability-counts.repository.js';
import { buildSeatAvailabilityChanged } from '../inventory-events.factory.js';
import { segmentOf } from '../segment.js';
import type { Segment } from '../segment.js';

/** int4range upper bound, for "every stop on this trip". */
const MAX_STOP_POSITION = 2147483647;

/** The whole route, for a change that touches every segment at once. */
export const WHOLE_TRIP: Segment = segmentOf(0, MAX_STOP_POSITION);

/**
 * Publishes `inventory.seat.availability-changed` for every station pair and
 * class a change touches. Catalog's invalidation consumer owns the payload
 * shape: one event per (trip, origin, destination, class), so it can drop
 * exactly the cache keys that went stale.
 */
@Injectable()
export class AvailabilityPublisher {
  constructor(
    @Inject(OUTBOX) private readonly outbox: OutboxPort,
    private readonly counts: AvailabilityCountsRepository,
  ) {}

  async publishChange(
    ctx: TransactionContext,
    tripId: string,
    changed: Segment,
    correlationId: string,
    now = new Date(),
  ): Promise<number> {
    const counts = await this.counts.countsOverlapping(ctx, tripId, changed);
    if (counts.length === 0) return 0;

    // One append: a trip with many stops and classes produces a row per pair,
    // and the relay should see them as one batch rather than N round trips.
    await this.outbox.appendBatch(
      ctx,
      counts.map((count) =>
        buildSeatAvailabilityChanged({
          eventId: randomUUID(),
          correlationId,
          occurredAt: now,
          payload: { tripId, ...count },
        }),
      ),
    );

    return counts.length;
  }
}
