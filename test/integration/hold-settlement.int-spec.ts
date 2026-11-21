import { randomUUID } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { DataSource } from 'typeorm';

import type { CreateHoldRequest, HoldSeatAssignment } from '@app/contracts';
import { DataSourceInitializer } from '@app/common/persistence/data-source-initializer.js';
import { TypeOrmUnitOfWork } from '@app/common/persistence/typeorm-unit-of-work.js';
import { TypeOrmOutboxRepository } from '@app/messaging';

import { HoldCoreRepository } from '../../apps/inventory/src/modules/seat-hold/hold-core.repository.js';
import { HoldCoreService } from '../../apps/inventory/src/modules/seat-hold/hold-core.service.js';
import { HoldSettlementService } from '../../apps/inventory/src/modules/seat-hold/hold-settlement.service.js';
import { AvailabilityCountsRepository } from '../../apps/inventory/src/modules/seats/repositories/availability-counts.repository.js';
import { AvailabilityPublisher } from '../../apps/inventory/src/modules/seats/services/availability-publisher.service.js';
import {
  closeInventoryDataSource,
  inventoryDataSource,
  truncateInventory,
} from './support/inventory-database.js';

const STATIONS = [
  '20000000-0000-4000-8000-000000000000',
  '20000000-0000-4000-8000-000000000001',
  '20000000-0000-4000-8000-000000000002',
  '20000000-0000-4000-8000-000000000003',
] as const;
const CLASS = '50000000-0000-4000-8000-000000000001';
const MINUTE = 60 * 1000;
const OWNER = '30000000-0000-4000-8000-000000000001';
const BOOKING = 'settlement-booking-key';

let source: DataSource;
let holdService: HoldCoreService;
let settlement: HoldSettlementService;

interface SeededTrip {
  tripId: string;
  seatIds: string[];
}

function atIn(minutes: number): Date {
  return new Date(Date.now() + minutes * MINUTE);
}

async function seedTrip(options: {
  departureAt: Date;
  seatCount?: number;
}): Promise<SeededTrip> {
  const tripId = randomUUID();
  const coachId = randomUUID();
  const seatCount = options.seatCount ?? 4;
  // Four stops: destination (position 2) is not the last stop, so a stop
  // reshuffle (test 7) can move it without deleting any station.
  const stopCount = 4;

  await source.query(
    `INSERT INTO inventory_trip
       (id, status, timetable_version, train_id, train_number, service_date)
     VALUES ($1, 'on_sale', 1, $2, 321, '2026-11-20')`,
    [tripId, randomUUID()],
  );

  for (let position = 0; position < stopCount; position += 1) {
    const arrival =
      position === 0
        ? null
        : new Date(options.departureAt.getTime() + position * 10 * MINUTE);
    const departure =
      position === stopCount - 1
        ? null
        : new Date(options.departureAt.getTime() + position * 10 * MINUTE);

    await source.query(
      `INSERT INTO trip_stop
         (trip_id, position, station_id, arrival_at, departure_at)
       VALUES ($1, $2, $3, $4, $5)`,
      [tripId, position, STATIONS[position], arrival, departure],
    );
  }

  await source.query(
    `INSERT INTO trip_coach
       (id, trip_id, coach_number, position, travel_class_id,
        travel_class_name_en, travel_class_name_ar)
     VALUES ($1, $2, 1, 0, $3, 'Economy', 'اقتصادية')`,
    [coachId, tripId, CLASS],
  );

  const seatIds: string[] = [];
  for (let seatNumber = 1; seatNumber <= seatCount; seatNumber += 1) {
    const seatId = randomUUID();
    seatIds.push(seatId);
    const side = seatNumber % 2 === 1 ? 'left' : 'right';
    const rowNumber = Math.ceil(seatNumber / 2);
    const indexInSide = Math.floor((seatNumber - 1) / 2);

    await source.query(
      `INSERT INTO trip_seat
         (id, trip_id, trip_coach_id, seat_number, travel_class_id,
          row_number, side, seat_index_in_side)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [seatId, tripId, coachId, String(seatNumber), CLASS, rowNumber, side, indexInSide],
    );
  }

  return { tripId, seatIds };
}

function leg(trip: SeededTrip, origin = 0, destination = 2) {
  return {
    tripId: trip.tripId,
    travelClassId: CLASS,
    originStationId: STATIONS[origin],
    destinationStationId: STATIONS[destination],
  };
}

function holdRequest(
  legs: ReturnType<typeof leg>[],
  passengerRefs: string[],
): CreateHoldRequest {
  return {
    ownerId: OWNER,
    bookingKey: BOOKING,
    legs,
    passengers: passengerRefs.map((ref) => ({
      passengerRef: ref,
      identities: legs.map((holdLeg) => ({
        tripId: holdLeg.tripId,
        passengerToken: `${ref}:${holdLeg.tripId}`,
        passengerKeyVersion: 1,
      })),
    })),
  };
}

interface HoldFixture {
  holdId: string;
  trips: SeededTrip[];
  assignments: HoldSeatAssignment[];
}

const fixture = {
  async twoPassengerOneLeg(): Promise<HoldFixture> {
    const trip = await seedTrip({ departureAt: atIn(120) });
    const snapshot = await holdService.createHold(
      holdRequest([leg(trip)], ['p-1', 'p-2']),
    );
    return { holdId: snapshot.holdId, trips: [trip], assignments: snapshot.assignments };
  },
  async roundTrip(): Promise<HoldFixture> {
    const outbound = await seedTrip({ departureAt: atIn(120) });
    const inbound = await seedTrip({ departureAt: atIn(180) });
    const snapshot = await holdService.createHold(
      holdRequest([leg(outbound), leg(inbound)], ['p-1', 'p-2']),
    );
    return {
      holdId: snapshot.holdId,
      trips: [outbound, inbound],
      assignments: snapshot.assignments,
    };
  },
};

function settleRequest() {
  return { ownerId: OWNER, bookingKey: BOOKING };
}

function seatIdsOf(assignments: HoldSeatAssignment[]): string[] {
  return assignments.map((a) => a.tripSeatId).sort();
}

function travelClassesOf(assignments: HoldSeatAssignment[]): string[] {
  return assignments.map((a) => a.travelClassId);
}

async function occupationStates(holdId: string): Promise<string[]> {
  const rows: { state: string }[] = await source.query(
    `SELECT state FROM seat_occupation WHERE hold_id = $1 AND released_at IS NULL ORDER BY trip_seat_id`,
    [holdId],
  );
  return rows.map((row) => row.state);
}

async function holdExpiryColumns(holdId: string): Promise<(Date | null)[]> {
  const rows: { hold_expires_at: Date | null }[] = await source.query(
    `SELECT hold_expires_at FROM seat_occupation WHERE hold_id = $1 AND released_at IS NULL ORDER BY trip_seat_id`,
    [holdId],
  );
  return rows.map((row) => row.hold_expires_at);
}

async function soldCount(tripId: string): Promise<number> {
  const [row]: { count: string }[] = await source.query(
    `SELECT count(*)::text AS count FROM seat_occupation
     WHERE trip_id = $1 AND state = 'sold' AND released_at IS NULL`,
    [tripId],
  );
  return Number(row.count);
}

async function soldCountForHold(holdId: string): Promise<number> {
  const [row]: { count: string }[] = await source.query(
    `SELECT count(*)::text AS count FROM seat_occupation
     WHERE hold_id = $1 AND state = 'sold' AND released_at IS NULL`,
    [holdId],
  );
  return Number(row.count);
}

/** Simulates a past-due hold: the settlement's own reclaim does the releasing. */
async function expireHold(holdId: string): Promise<void> {
  const past = new Date(Date.now() - MINUTE);
  await source.query(
    `UPDATE seat_hold_group SET expires_at = $2 WHERE id = $1`,
    [holdId, past],
  );
  await source.query(
    `UPDATE seat_occupation SET hold_expires_at = $2 WHERE hold_id = $1 AND state = 'held'`,
    [holdId, past],
  );
}

/** The seat's own expired hold is released first, as the expiry worker would. */
async function releaseExpiredOccupation(seatId: string): Promise<void> {
  await source.query(
    `UPDATE seat_occupation SET released_at = clock_timestamp(), updated_at = clock_timestamp()
     WHERE trip_seat_id = $1 AND released_at IS NULL`,
    [seatId],
  );
}

async function sellSeatsToSomeoneElse(seatIds: string[]): Promise<void> {
  for (const seatId of seatIds) {
    await releaseExpiredOccupation(seatId);
    const [row]: { trip_id: string }[] = await source.query(
      `SELECT trip_id FROM trip_seat WHERE id = $1`,
      [seatId],
    );
    await source.query(
      `INSERT INTO seat_occupation (id, trip_seat_id, trip_id, segment, state, hold_expires_at)
       VALUES ($1, $2, $3, '[0,1000)'::int4range, 'sold', NULL)`,
      [randomUUID(), seatId, row.trip_id],
    );
  }
}

async function sellEverySeatInClass(tripId: string, travelClassId: string): Promise<void> {
  const rows: { id: string }[] = await source.query(
    `SELECT id FROM trip_seat WHERE trip_id = $1 AND travel_class_id = $2`,
    [tripId, travelClassId],
  );
  for (const row of rows) {
    await releaseExpiredOccupation(row.id);
    await source.query(
      `INSERT INTO seat_occupation (id, trip_seat_id, trip_id, segment, state, hold_expires_at)
       VALUES ($1, $2, $3, '[0,1000)'::int4range, 'sold', NULL)`,
      [randomUUID(), row.id, tripId],
    );
  }
}

async function closeTripForSales(tripId: string): Promise<void> {
  await source.query(`UPDATE inventory_trip SET status = 'closed' WHERE id = $1`, [tripId]);
}

/** A timetable republication that moves the destination's stop position. */
async function bumpTimetableVersion(tripId: string): Promise<void> {
  await source.query(
    `UPDATE trip_stop SET position = 999 WHERE trip_id = $1 AND position = 2`,
    [tripId],
  );
  await source.query(
    `UPDATE trip_stop SET position = 2 WHERE trip_id = $1 AND position = 3`,
    [tripId],
  );
  await source.query(
    `UPDATE trip_stop SET position = 3 WHERE trip_id = $1 AND position = 999`,
    [tripId],
  );
  await source.query(
    `UPDATE inventory_trip SET timetable_version = timetable_version + 1 WHERE id = $1`,
    [tripId],
  );
}

async function outboxEventTypes(): Promise<string[]> {
  const rows: { event_type: string }[] = await source.query(
    `SELECT event_type FROM outbox_event ORDER BY occurred_at, event_type`,
  );
  return rows.map((row) => row.event_type);
}

beforeEach(async () => {
  source = await inventoryDataSource();
  await truncateInventory(source);

  const initializer = new DataSourceInitializer(source);
  const repository = new HoldCoreRepository();
  const unitOfWork = new TypeOrmUnitOfWork(initializer);
  const outbox = new TypeOrmOutboxRepository(initializer);
  holdService = new HoldCoreService(repository, unitOfWork, outbox);
  settlement = new HoldSettlementService(
    repository,
    unitOfWork,
    new AvailabilityPublisher(outbox, new AvailabilityCountsRepository()),
  );
});

afterAll(async () => {
  await closeInventoryDataSource();
});

describe('BR-36 hold settlement', () => {
  it('turns a live hold into sold seats on exactly the held segments', async () => {
    const hold = await fixture.twoPassengerOneLeg();
    const result = await settlement.settle(settleRequest());

    expect(result.outcome).toBe('SOLD');
    expect(await occupationStates(hold.holdId)).toEqual(['sold', 'sold']);
    expect(await holdExpiryColumns(hold.holdId)).toEqual([null, null]);
    expect(seatIdsOf(result.assignments)).toEqual(seatIdsOf(hold.assignments));
  });

  it('sells once when settled twice', async () => {
    const hold = await fixture.twoPassengerOneLeg();
    const first = await settlement.settle(settleRequest());
    const second = await settlement.settle(settleRequest());

    expect(second.outcome).toBe('SOLD');
    expect(seatIdsOf(second.assignments)).toEqual(seatIdsOf(first.assignments));
    expect(await soldCount(hold.trips[0].tripId)).toBe(2);
  });

  it('re-acquires the same seats when the hold expired and they are still free', async () => {
    const hold = await fixture.twoPassengerOneLeg();
    await expireHold(hold.holdId);
    const result = await settlement.settle(settleRequest());

    expect(result.outcome).toBe('SOLD');
    expect(seatIdsOf(result.assignments)).toEqual(seatIdsOf(hold.assignments));
  });

  it('allocates new seats in the same class when the held ones were taken', async () => {
    const hold = await fixture.twoPassengerOneLeg();
    await expireHold(hold.holdId);
    await sellSeatsToSomeoneElse(seatIdsOf(hold.assignments));
    const result = await settlement.settle(settleRequest());

    expect(result.outcome).toBe('REALLOCATED');
    expect(seatIdsOf(result.assignments)).not.toEqual(seatIdsOf(hold.assignments));
    expect(travelClassesOf(result.assignments)).toEqual([CLASS, CLASS]);
  });

  it('changes nothing and answers NO_SEATS when the class is full', async () => {
    const hold = await fixture.twoPassengerOneLeg();
    await expireHold(hold.holdId);
    await sellEverySeatInClass(hold.trips[0].tripId, CLASS);

    expect((await settlement.settle(settleRequest())).outcome).toBe('NO_SEATS');
    expect(await soldCountForHold(hold.holdId)).toBe(0);
  });

  it('answers NO_SEATS for a trip that is cancelled or closed for sales', async () => {
    const hold = await fixture.twoPassengerOneLeg();
    await closeTripForSales(hold.trips[0].tripId);

    expect((await settlement.settle(settleRequest())).outcome).toBe('NO_SEATS');
  });

  it('refuses to re-acquire when the timetable version moved under the hold', async () => {
    const hold = await fixture.twoPassengerOneLeg();
    await expireHold(hold.holdId);
    await bumpTimetableVersion(hold.trips[0].tripId);
    const result = await settlement.settle(settleRequest());

    expect(result.outcome).not.toBe('SOLD');
  });

  it('settles a round trip as one decision, or not at all', async () => {
    const hold = await fixture.roundTrip();
    await expireHold(hold.holdId);
    await sellEverySeatInClass(hold.trips[1].tripId, CLASS);

    expect((await settlement.settle(settleRequest())).outcome).toBe('NO_SEATS');
    expect(await soldCount(hold.trips[0].tripId)).toBe(0);
  });

  it('appends an availability-changed event for every trip it sold on', async () => {
    await fixture.roundTrip();
    await settlement.settle(settleRequest());

    expect(await outboxEventTypes()).toContain(
      'inventory.seat.availability-changed',
    );
  });
});
