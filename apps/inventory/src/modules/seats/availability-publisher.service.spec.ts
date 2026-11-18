import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { TransactionContext } from '@app/common/persistence/unit-of-work.port.js';

import {
  AvailabilityPublisher,
  WHOLE_TRIP,
} from './availability-publisher.service.js';
import type { SegmentCount } from './availability-counts.repository.js';

const tripId = '11111111-1111-4111-8111-111111111111';
const cairo = '22222222-2222-4222-8222-222222222222';
const tanta = '33333333-3333-4333-8333-333333333333';
const alexandria = '44444444-4444-4444-8444-444444444444';
const economy = '55555555-5555-4555-8555-555555555555';

describe('AvailabilityPublisher', () => {
  const ctx = { driver: 'typeorm' } as TransactionContext;

  let outbox: { append: ReturnType<typeof vi.fn>; appendBatch: ReturnType<typeof vi.fn> };
  let counts: { countsOverlapping: ReturnType<typeof vi.fn> };
  let publisher: AvailabilityPublisher;

  beforeEach(() => {
    outbox = {
      append: vi.fn().mockResolvedValue(undefined),
      appendBatch: vi.fn().mockResolvedValue(undefined),
    };
    counts = { countsOverlapping: vi.fn() };
    publisher = new AvailabilityPublisher(
      outbox as never,
      counts as never,
    );
  });

  const twoSegments: SegmentCount[] = [
    {
      originStationId: cairo,
      destinationStationId: tanta,
      travelClassId: economy,
      availableSeats: 18,
    },
    {
      originStationId: cairo,
      destinationStationId: alexandria,
      travelClassId: economy,
      availableSeats: 11,
    },
  ];

  it('publishes one event per station pair and class, in the payload catalog reads', async () => {
    counts.countsOverlapping.mockResolvedValue(twoSegments);

    const published = await publisher.publishChange(
      ctx,
      tripId,
      WHOLE_TRIP,
      'corr-1',
      new Date('2026-11-19T09:00:00.000Z'),
    );

    expect(published).toBe(2);
    expect(outbox.appendBatch).toHaveBeenCalledTimes(1);

    const [appendedCtx, events] = outbox.appendBatch.mock.calls[0];
    expect(appendedCtx).toBe(ctx);
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({
      type: 'inventory.seat.availability-changed',
      version: 1,
      producer: 'inventory',
      correlationId: 'corr-1',
      occurredAt: '2026-11-19T09:00:00.000Z',
      payload: {
        tripId,
        originStationId: cairo,
        destinationStationId: tanta,
        travelClassId: economy,
        availableSeats: 18,
      },
    });
    expect(events[1].payload).toEqual({
      tripId,
      originStationId: cairo,
      destinationStationId: alexandria,
      travelClassId: economy,
      availableSeats: 11,
    });
  });

  it('gives every event its own id so a retry cannot collapse two segments', async () => {
    counts.countsOverlapping.mockResolvedValue(twoSegments);

    await publisher.publishChange(ctx, tripId, WHOLE_TRIP, 'corr-1');

    const [, events] = outbox.appendBatch.mock.calls[0];
    expect(new Set(events.map((event: { id: string }) => event.id)).size).toBe(
      2,
    );
  });

  it('appends nothing when the change touches no segment', async () => {
    counts.countsOverlapping.mockResolvedValue([]);

    await expect(
      publisher.publishChange(ctx, tripId, WHOLE_TRIP, 'corr-1'),
    ).resolves.toBe(0);
    expect(outbox.appendBatch).not.toHaveBeenCalled();
    expect(outbox.append).not.toHaveBeenCalled();
  });

  it('asks only for the segments the change overlaps', async () => {
    counts.countsOverlapping.mockResolvedValue([]);

    await publisher.publishChange(ctx, tripId, { from: 1, to: 3 }, 'corr-1');

    expect(counts.countsOverlapping).toHaveBeenCalledWith(ctx, tripId, {
      from: 1,
      to: 3,
    });
  });
});
