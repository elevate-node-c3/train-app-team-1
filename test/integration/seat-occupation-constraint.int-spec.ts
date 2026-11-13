import { beforeEach, describe, expect, it } from 'vitest';
import type { DataSource } from 'typeorm';

import { parseInt4Range, segmentOf } from '../../apps/inventory/src/modules/seats/segment.js';
import { SeatOccupationEntity } from '../../apps/inventory/src/modules/seats/entities/seat-occupation.entity.js';

import { inventoryDataSource, truncateInventory } from './support/inventory-database.js';
import {
  occupy as occupySeat,
  release as releaseSeat,
  seedSixStopTrip,
  SIX_STOP_TRIP,
} from './support/inventory-fixture.js';

// Ramsis 0, Banha 1, Tanta 2, Damnhour 3, Sidi Gaber 4, ElRaml 5.
const seat44 = SIX_STOP_TRIP.seatIds[0];
const otherSeat = SIX_STOP_TRIP.seatIds[1];
const tripId = SIX_STOP_TRIP.tripId;
const inThePast = new Date(Date.now() - 60 * 60_000);

let source: DataSource;

function occupy(
  seatId: string,
  segment: ReturnType<typeof segmentOf>,
  state: 'sold',
): Promise<string>;
function occupy(
  seatId: string,
  segment: ReturnType<typeof segmentOf>,
  state: 'held',
  holdExpiresAt: Date,
): Promise<string>;
function occupy(
  seatId: string,
  segment: ReturnType<typeof segmentOf>,
  state: 'held' | 'sold',
  holdExpiresAt?: Date,
): Promise<string> {
  if (state === 'held') return occupySeat(source, seatId, tripId, segment, 'held', holdExpiresAt as Date);
  return occupySeat(source, seatId, tripId, segment, 'sold');
}

const anHourFromNow = (): Date => new Date(Date.now() + 60 * 60_000);

function release(id: string): Promise<void> {
  return releaseSeat(source, id);
}

/** Raw insert, bypassing segmentOf, so edge-case segments like `[2,2)` can reach the database. */
function occupyRaw(
  seatId: string,
  segmentLiteral: string,
  state: 'held' | 'sold',
  options: { holdExpiresAt?: Date | null } = {},
): Promise<unknown> {
  const holdExpiresAt =
    options.holdExpiresAt !== undefined
      ? options.holdExpiresAt
      : state === 'held'
        ? new Date(Date.now() + 60 * 60_000)
        : null;

  return source.query(
    `INSERT INTO seat_occupation (id, trip_seat_id, trip_id, segment, state, hold_expires_at)
     VALUES (gen_random_uuid(), $1, $2, $3::int4range, $4, $5)`,
    [seatId, tripId, segmentLiteral, state, holdExpiresAt],
  );
}

function deleteSeat(seatId: string): Promise<unknown> {
  return source.query(`DELETE FROM trip_seat WHERE id = $1`, [seatId]);
}

beforeEach(async () => {
  source = await inventoryDataSource();
  await truncateInventory(source);
  await seedSixStopTrip(source);
});

describe('the seat-occupation exclusion constraint', () => {
  it('refuses two overlapping occupations of one seat', async () => {
    await occupy(seat44, segmentOf(0, 5), 'sold');
    await expect(
      occupy(seat44, segmentOf(1, 2), 'held', anHourFromNow()),
    ).rejects.toThrow(/excl_seat_occupation_overlap/);
  });

  it('accepts two touching occupations of one seat', async () => {
    await occupy(seat44, segmentOf(0, 2), 'sold');
    await expect(occupy(seat44, segmentOf(2, 5), 'sold')).resolves.toBeDefined();
  });

  it('accepts the same segment on a different seat', async () => {
    // trip_seat_id WITH =: the exclusion only compares occupations of the same seat.
    await occupy(seat44, segmentOf(0, 5), 'sold');
    await expect(occupy(otherSeat, segmentOf(0, 5), 'sold')).resolves.toBeDefined();
  });

  it('refuses an empty segment', async () => {
    await expect(occupyRaw(seat44, '[2,2)', 'sold')).rejects.toThrow(
      /chk_seat_occupation_segment/,
    );
  });

  it('refuses a held row with no expiry', async () => {
    await expect(
      occupyRaw(seat44, '[0,2)', 'held', { holdExpiresAt: null }),
    ).rejects.toThrow(/chk_seat_occupation_hold_expiry/);
  });

  it('refuses a sold row carrying an expiry', async () => {
    // Same CHECK, other direction: (state = 'held') = (hold_expires_at IS NOT NULL).
    await expect(
      occupyRaw(seat44, '[0,2)', 'sold', { holdExpiresAt: new Date() }),
    ).rejects.toThrow(/chk_seat_occupation_hold_expiry/);
  });

  it('stops blocking once released', async () => {
    const id = await occupy(seat44, segmentOf(0, 5), 'held', anHourFromNow());
    await release(id);
    await expect(occupy(seat44, segmentOf(1, 2), 'sold')).resolves.toBeDefined();
  });

  it('keeps blocking while a hold is merely expired', async () => {
    // The index predicate cannot call now(), so an expired hold still blocks
    // until something writes released_at (spec §6.3).
    await occupy(seat44, segmentOf(0, 5), 'held', inThePast);
    await expect(occupy(seat44, segmentOf(1, 2), 'sold')).rejects.toThrow(
      /excl_seat_occupation_overlap/,
    );
  });

  it('refuses a seat delete while an occupation stands', async () => {
    await occupy(seat44, segmentOf(0, 2), 'sold');
    await expect(deleteSeat(seat44)).rejects.toThrow(/seat_occupation/);
  });

  it('refuses an occupation whose trip_id disagrees with its seat\'s real trip', async () => {
    // A second, real trip so trip_id itself is valid — isolates the failure
    // to the composite FK, not a missing inventory_trip row.
    const otherTripId = '10000000-0000-0000-0000-000000000002';
    await source.query(
      `INSERT INTO inventory_trip (id, status, timetable_version, train_id, train_number, service_date)
       VALUES ($1, 'on_sale', 1, '60000000-0000-0000-0000-000000000001', 999, '2026-01-01')`,
      [otherTripId],
    );

    await expect(
      source.query(
        `INSERT INTO seat_occupation (id, trip_seat_id, trip_id, segment, state, hold_expires_at)
         VALUES (gen_random_uuid(), $1, $2, '[0,2)'::int4range, 'sold', NULL)`,
        [seat44, otherTripId],
      ),
    ).rejects.toThrow(/fk_seat_occupation_seat/);
  });
});

describe('int4range round-tripping', () => {
  // Review Focus 1: a silent mis-parse breaks every overlap decision while
  // every unit test still passes.
  it('reads back through parseInt4Range exactly as written', async () => {
    await occupy(seat44, segmentOf(0, 2), 'sold');
    const [row] = await source.query('SELECT segment::text FROM seat_occupation');
    expect(parseInt4Range(row.segment)).toEqual({ from: 0, to: 2 });
  });

  it('reads back through the entity the same way', async () => {
    await occupy(seat44, segmentOf(0, 2), 'sold');
    const found = await source.getRepository(SeatOccupationEntity).findOneByOrFail({});
    expect(parseInt4Range(found.segment)).toEqual({ from: 0, to: 2 });
  });
});
