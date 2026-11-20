import { randomUUID } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { DataSource } from 'typeorm';

import {
  AllocationOutcome,
  ErrorCode,
  type CreateHoldRequest,
} from '@app/contracts';
import { DataSourceInitializer } from '@app/common/persistence/data-source-initializer.js';
import { TypeOrmUnitOfWork } from '@app/common/persistence/typeorm-unit-of-work.js';
import { TypeOrmOutboxRepository } from '@app/messaging';

import { HoldCoreError } from '../../apps/inventory/src/modules/seat-hold/hold-core.errors.js';
import { HoldCoreRepository } from '../../apps/inventory/src/modules/seat-hold/hold-core.repository.js';
import { HoldCoreService } from '../../apps/inventory/src/modules/seat-hold/hold-core.service.js';
import { HoldCreationGuard } from '../../apps/inventory/src/modules/seat-hold/hold-access.guard.js';
import { SchemaReadinessGate } from '@app/common';
import { SeatPlanRepository } from '../../apps/inventory/src/modules/seats/repositories/seat-plan.repository.js';
import type { SeatPlan } from '../../apps/inventory/src/modules/seats/seat-plan.js';
import { CreateHoldCore1794600000008 } from '../../apps/inventory/src/database/migrations/1794600000008-create-hold-core.js';
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
const TRAVEL_CLASS = '50000000-0000-4000-8000-000000000001';
const MINUTE = 60 * 1000;

let source: DataSource;
let service: HoldCoreService;

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
  stops?: number;
}): Promise<SeededTrip> {
  const tripId = randomUUID();
  const coachId = randomUUID();
  const stopCount = options.stops ?? 3;
  const seatCount = options.seatCount ?? 4;

  await source.query(
    `INSERT INTO inventory_trip
       (id, status, timetable_version, train_id, train_number, service_date)
     VALUES ($1, 'on_sale', 1, $2, 123, '2026-11-20')`,
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
    [coachId, tripId, TRAVEL_CLASS],
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
      [
        seatId,
        tripId,
        coachId,
        String(seatNumber),
        TRAVEL_CLASS,
        rowNumber,
        side,
        indexInSide,
      ],
    );
  }

  return { tripId, seatIds };
}

function leg(trip: SeededTrip, origin = 0, destination = 2) {
  return {
    tripId: trip.tripId,
    travelClassId: TRAVEL_CLASS,
    originStationId: STATIONS[origin],
    destinationStationId: STATIONS[destination],
  };
}

interface PassengerSpec {
  passengerRef: string;
  token: string;
  version: number;
}

function passenger(ref: string, token: string, version = 1): PassengerSpec {
  return {
    passengerRef: ref,
    token,
    version,
  };
}

function request(
  legs: ReturnType<typeof leg>[],
  passengers: PassengerSpec[],
  options: { ownerId?: string; bookingKey?: string } = {},
): CreateHoldRequest {
  return {
    ownerId: options.ownerId ?? randomUUID(),
    bookingKey: options.bookingKey ?? randomUUID(),
    legs,
    passengers: passengers.map((spec) => ({
      passengerRef: spec.passengerRef,
      identities: legs.map((holdLeg) => ({
        tripId: holdLeg.tripId,
        passengerToken: `${spec.token}:${holdLeg.tripId}`,
        passengerKeyVersion: spec.version,
      })),
    })),
  };
}

async function resetHolds(): Promise<void> {
  await source.query(
    `TRUNCATE TABLE
       seat_hold_assignment,
       seat_hold_leg,
       seat_hold_passenger,
       seat_hold_group,
       seat_hold_owner_guard,
       seat_occupation
     CASCADE`,
  );
}

async function occupySold(
  tripSeatId: string,
  tripId: string,
  from = 0,
  to = 2,
): Promise<void> {
  await source.query(
    `INSERT INTO seat_occupation
       (id, trip_seat_id, trip_id, segment, state, hold_expires_at)
     VALUES ($1, $2, $3, $4::int4range, 'sold', NULL)`,
    [randomUUID(), tripSeatId, tripId, `[${from},${to})`],
  );
}

async function activeOccupationCount(tripId: string): Promise<number> {
  const [row]: { count: string }[] = await source.query(
    `SELECT count(*)::text AS count
     FROM seat_occupation
     WHERE trip_id = $1 AND released_at IS NULL`,
    [tripId],
  );
  return Number(row.count);
}

async function eventTypes(): Promise<string[]> {
  const rows: { event_type: string }[] = await source.query(
    `SELECT event_type FROM outbox_event ORDER BY occurred_at, event_type`,
  );
  return rows.map((row) => row.event_type);
}

async function expectHoldError(
  promise: Promise<unknown>,
  code: ErrorCode,
): Promise<void> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(HoldCoreError);
    expect((error as HoldCoreError).code).toBe(code);
    return;
  }

  throw new Error(`Expected HoldCoreError with code ${code}.`);
}

beforeEach(async () => {
  source = await inventoryDataSource();
  await truncateInventory(source);

  const initializer = new DataSourceInitializer(source);
  const repository = new HoldCoreRepository();
  const unitOfWork = new TypeOrmUnitOfWork(initializer);
  const outbox = new TypeOrmOutboxRepository(initializer);
  service = new HoldCoreService(repository, unitOfWork, outbox);
});

afterAll(async () => {
  await closeInventoryDataSource();
});

describe('MT-17 atomic multi-passenger, multi-leg holds', () => {
  it('allocates every passenger on both legs and commits one held event', async () => {
    const outbound = await seedTrip({ departureAt: atIn(120) });
    const inbound = await seedTrip({ departureAt: atIn(180) });
    const req = request(
      [leg(outbound), leg(inbound)],
      [passenger('p-1', 'token-1'), passenger('p-2', 'token-2')],
    );

    const snapshot = await service.createHold(req, 'corr-1');

    expect(snapshot.state).toBe('HELD');
    expect(snapshot.version).toBe(1);
    expect(snapshot.extensionUsed).toBe(false);
    expect(snapshot.allocationOutcome).toBe(AllocationOutcome.SAME_COACH);
    expect(
      snapshot.legs.every(
        (legResult) => legResult.outcome === snapshot.allocationOutcome,
      ),
    ).toBe(true);
    expect(snapshot.legs).toHaveLength(2);
    expect(snapshot.assignments).toHaveLength(4);

    for (const trip of [outbound, inbound]) {
      const legAssignments = snapshot.assignments.filter(
        (assignment) => assignment.tripId === trip.tripId,
      );
      expect(
        legAssignments.map((assignment) => assignment.passengerRef).sort(),
      ).toEqual(['p-1', 'p-2']);
      expect(
        legAssignments.every((assignment) =>
          trip.seatIds.includes(assignment.tripSeatId),
        ),
      ).toBe(true);
    }

    // Identity tokens are trip-scoped: the round trip stores four snapshots,
    // and the same passenger has a different token on each trip.
    const identityRows: {
      trip_id: string;
      passenger_ref: string;
      passenger_token: string;
      passenger_key_version: number;
    }[] = await source.query(
      `SELECT trip_id, passenger_ref, passenger_token, passenger_key_version
       FROM seat_hold_passenger
       ORDER BY trip_id, passenger_ref`,
    );
    expect(identityRows).toHaveLength(4);
    for (const row of identityRows) {
      const expected = req.passengers
        .find((item) => item.passengerRef === row.passenger_ref)
        ?.identities.find((identity) => identity.tripId === row.trip_id);
      expect(expected).toBeDefined();
      expect(row.passenger_token).toBe(expected?.passengerToken);
      expect(row.passenger_key_version).toBe(expected?.passengerKeyVersion);
    }
    const p1Tokens = identityRows
      .filter((row) => row.passenger_ref === 'p-1')
      .map((row) => row.passenger_token);
    expect(new Set(p1Tokens).size).toBe(2);

    const serverNow = new Date(snapshot.serverNow).getTime();
    const expiresAt = new Date(snapshot.expiresAt as string).getTime();
    expect(expiresAt).toBeGreaterThan(serverNow + 14 * MINUTE);
    expect(expiresAt).toBeLessThanOrEqual(serverNow + 15 * MINUTE + 1_000);

    const [counts]: {
      groups: string;
      passengers: string;
      legs: string;
      assignments: string;
      occupations: string;
      events: string;
    }[] = await source.query(
      `SELECT
         (SELECT count(*) FROM seat_hold_group)::text AS groups,
         (SELECT count(*) FROM seat_hold_passenger)::text AS passengers,
         (SELECT count(*) FROM seat_hold_leg)::text AS legs,
         (SELECT count(*) FROM seat_hold_assignment)::text AS assignments,
         (SELECT count(*) FROM seat_occupation WHERE released_at IS NULL)::text AS occupations,
         (SELECT count(*) FROM outbox_event)::text AS events`,
    );

    expect(counts).toEqual({
      groups: '1',
      passengers: '4', // one identity snapshot per passenger per leg
      legs: '2',
      assignments: '4',
      occupations: '4',
      events: '1',
    });
    expect(await eventTypes()).toEqual(['inventory.hold.held']);
  });

  it('rolls back the outbound allocation when the return leg is full', async () => {
    const outbound = await seedTrip({ departureAt: atIn(120) });
    const inbound = await seedTrip({
      departureAt: atIn(180),
      seatCount: 1,
    });
    await occupySold(inbound.seatIds[0], inbound.tripId);

    const req = request(
      [leg(outbound), leg(inbound)],
      [passenger('p-1', 'token-1'), passenger('p-2', 'token-2')],
    );

    await expectHoldError(service.createHold(req), ErrorCode.SEAT_TAKEN);

    expect(await activeOccupationCount(outbound.tripId)).toBe(0);
    expect(await activeOccupationCount(inbound.tripId)).toBe(1); // the pre-existing sold row

    const [counts]: { groups: string; assignments: string; events: string }[] =
      await source.query(
        `SELECT
           (SELECT count(*) FROM seat_hold_group)::text AS groups,
           (SELECT count(*) FROM seat_hold_assignment)::text AS assignments,
           (SELECT count(*) FROM outbox_event)::text AS events`,
      );
    expect(counts).toEqual({ groups: '0', assignments: '0', events: '0' });
  });

  it('uses Inventory departure data and refuses a 14-minute cutoff', async () => {
    const trip = await seedTrip({ departureAt: atIn(14) });
    const req = request([leg(trip)], [passenger('p-1', 'token-1')]);

    await expectHoldError(service.createHold(req), ErrorCode.SALES_CLOSED);
  });

  it('caps a 20-minute departure hold at the sales cutoff', async () => {
    const trip = await seedTrip({ departureAt: atIn(20) });
    const req = request([leg(trip)], [passenger('p-1', 'token-1')]);

    const snapshot = await service.createHold(req);
    const serverNow = new Date(snapshot.serverNow).getTime();
    const expiresAt = new Date(snapshot.expiresAt as string).getTime();

    expect(expiresAt).toBeGreaterThan(serverNow + 4 * MINUTE);
    expect(expiresAt).toBeLessThanOrEqual(serverNow + 5 * MINUTE + 1_000);
  });

  it('refuses at the exact DB cutoff even when app time would differ', async () => {
    const trip = await seedTrip({ departureAt: atIn(120) });
    await source.query(
      `UPDATE trip_stop
       SET departure_at = clock_timestamp() + interval '15 minutes'
       WHERE trip_id = $1 AND position = 0`,
      [trip.tripId],
    );

    const req = request([leg(trip)], [passenger('p-1', 'token-1')]);

    await expectHoldError(service.createHold(req), ErrorCode.SALES_CLOSED);
  });
});

describe('MT-18 replacement and concurrency', () => {
  it('proves exactly one winner for the last seat over 50 races', async () => {
    const trip = await seedTrip({ departureAt: atIn(120), seatCount: 1 });

    for (let iteration = 0; iteration < 50; iteration += 1) {
      await resetHolds();

      const ownerA = randomUUID();
      const ownerB = randomUUID();
      const reqA = request([leg(trip)], [passenger('p-a', 'token-a')], {
        ownerId: ownerA,
        bookingKey: randomUUID(),
      });
      const reqB = request([leg(trip)], [passenger('p-b', 'token-b')], {
        ownerId: ownerB,
        bookingKey: randomUUID(),
      });

      const results = await Promise.allSettled([
        service.createHold(reqA, `race-a-${iteration}`),
        service.createHold(reqB, `race-b-${iteration}`),
      ]);

      const fulfilled = results.filter(
        (result) => result.status === 'fulfilled',
      );
      const rejected = results.filter(
        (result): result is PromiseRejectedResult =>
          result.status === 'rejected',
      );

      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      expect(rejected[0].reason).toBeInstanceOf(HoldCoreError);
      expect((rejected[0].reason as HoldCoreError).code).toBe(
        ErrorCode.SEAT_TAKEN,
      );

      expect(await activeOccupationCount(trip.tripId)).toBe(1);
      const [held]: { count: string }[] = await source.query(
        `SELECT count(*)::text AS count
         FROM seat_hold_group
         WHERE state = 'held'`,
      );
      expect(held.count).toBe('1');
    }
  });

  it('replaces the previous active hold atomically and preserves it on failure', async () => {
    const trip = await seedTrip({ departureAt: atIn(120), seatCount: 2 });
    const full = await seedTrip({ departureAt: atIn(180), seatCount: 1 });
    await occupySold(full.seatIds[0], full.tripId);

    const ownerId = randomUUID();
    const first = request([leg(trip)], [passenger('p-1', 'token-1')], {
      ownerId,
      bookingKey: 'key-1',
    });
    const second = request([leg(trip)], [passenger('p-1', 'token-1')], {
      ownerId,
      bookingKey: 'key-2',
    });
    const failing = request(
      [leg(full)],
      [passenger('p-1', 'token-1'), passenger('p-2', 'token-2')],
      { ownerId, bookingKey: 'key-3' },
    );

    const firstSnapshot = await service.createHold(first);
    const secondSnapshot = await service.createHold(second);

    expect(secondSnapshot.holdId).not.toBe(firstSnapshot.holdId);
    expect(secondSnapshot.state).toBe('HELD');

    const released = await service.getHold({
      ownerId,
      bookingKey: 'key-1',
    });
    expect(released.state).toBe('RELEASED');
    expect(released.version).toBe(2);

    const [active]: { count: string }[] = await source.query(
      `SELECT count(*)::text AS count
       FROM seat_hold_group
       WHERE owner_id = $1 AND state = 'held'`,
      [ownerId],
    );
    expect(active.count).toBe('1');

    await expectHoldError(service.createHold(failing), ErrorCode.SEAT_TAKEN);

    const stillActive = await service.getHold({
      ownerId,
      bookingKey: 'key-2',
    });
    expect(stillActive.state).toBe('HELD');
    expect(stillActive.version).toBe(1);
    expect(stillActive.assignments).toHaveLength(1);
  });

  it('leaves exactly one active hold when the same traveller races two sessions', async () => {
    const trip = await seedTrip({ departureAt: atIn(120), seatCount: 2 });
    const ownerId = randomUUID();

    const results = await Promise.allSettled([
      service.createHold(
        request([leg(trip)], [passenger('p-1', 'token-1')], {
          ownerId,
          bookingKey: 'race-key-1',
        }),
      ),
      service.createHold(
        request([leg(trip)], [passenger('p-1', 'token-1')], {
          ownerId,
          bookingKey: 'race-key-2',
        }),
      ),
    ]);

    expect(results.every((result) => result.status === 'fulfilled')).toBe(true);

    const [active]: { count: string }[] = await source.query(
      `SELECT count(*)::text AS count
       FROM seat_hold_group
       WHERE owner_id = $1 AND state = 'held'`,
      [ownerId],
    );
    expect(active.count).toBe('1');

    const [all]: { count: string }[] = await source.query(
      `SELECT count(*)::text AS count
       FROM seat_hold_group
       WHERE owner_id = $1`,
      [ownerId],
    );
    expect(all.count).toBe('2'); // one held, one released by replacement
  });
});

describe('MT-15 replay and MT-19 release fencing', () => {
  it('releases a create that wins the unknown-key cancellation insert race', async () => {
    const trip = await seedTrip({ departureAt: atIn(120) });
    const req = request([leg(trip)], [passenger('p-1', 'token-1')]);
    let sawMissingKey: () => void = () => {};
    let continueRelease: () => void = () => {};
    const missing = new Promise<void>((resolve) => {
      sawMissingKey = resolve;
    });
    const resume = new Promise<void>((resolve) => {
      continueRelease = resolve;
    });
    class PausedCancellationRepository extends HoldCoreRepository {
      override async insertCancellationTombstone(
        ...args: Parameters<HoldCoreRepository['insertCancellationTombstone']>
      ): Promise<void> {
        sawMissingKey();
        await resume;
        return super.insertCancellationTombstone(...args);
      }
    }
    const initializer = new DataSourceInitializer(source);
    const releasingService = new HoldCoreService(
      new PausedCancellationRepository(),
      new TypeOrmUnitOfWork(initializer),
      new TypeOrmOutboxRepository(initializer),
    );
    const release = releasingService.releaseHold({
      ownerId: req.ownerId,
      bookingKey: req.bookingKey,
    });
    await missing;
    try {
      expect((await service.createHold(req)).state).toBe('HELD');
    } finally {
      continueRelease();
    }
    expect(await release).toMatchObject({ state: 'RELEASED', version: 2 });
    expect(await activeOccupationCount(trip.tripId)).toBe(0);
    expect(await eventTypes()).toEqual([
      'inventory.hold.held',
      'inventory.hold.released',
    ]);
  });

  it('replays the original snapshot without reallocating or resetting TTL', async () => {
    const trip = await seedTrip({ departureAt: atIn(120) });
    const req = request([leg(trip)], [passenger('p-1', 'token-1')]);

    const first = await service.createHold(req);
    const replay = await service.createHold(req);

    expect(replay.holdId).toBe(first.holdId);
    expect(replay.assignments).toEqual(first.assignments);
    expect(replay.expiresAt).toBe(first.expiresAt);

    const [counts]: { groups: string; assignments: string; events: string }[] =
      await source.query(
        `SELECT
           (SELECT count(*) FROM seat_hold_group)::text AS groups,
           (SELECT count(*) FROM seat_hold_assignment)::text AS assignments,
           (SELECT count(*) FROM outbox_event)::text AS events`,
      );
    expect(counts).toEqual({ groups: '1', assignments: '1', events: '1' });
  });

  it('refuses a changed payload or a different owner on the same key', async () => {
    const trip = await seedTrip({ departureAt: atIn(120) });
    const req = request([leg(trip)], [passenger('p-1', 'token-1')]);
    await service.createHold(req);

    const changed = request([leg(trip)], [passenger('p-1', 'token-2')], {
      ownerId: req.ownerId,
      bookingKey: req.bookingKey,
    });
    await expectHoldError(
      service.createHold(changed),
      ErrorCode.BOOKING_KEY_CONFLICT,
    );

    const otherOwner = request([leg(trip)], [passenger('p-1', 'token-1')], {
      ownerId: randomUUID(),
      bookingKey: req.bookingKey,
    });
    await expectHoldError(
      service.createHold(otherOwner),
      ErrorCode.BOOKING_KEY_CONFLICT,
    );
  });

  it('releases by key, is retry-safe, and fences an unknown-key late create', async () => {
    const trip = await seedTrip({ departureAt: atIn(120) });
    const req = request([leg(trip)], [passenger('p-1', 'token-1')]);
    const created = await service.createHold(req);

    const released = await service.releaseHold({
      ownerId: req.ownerId,
      bookingKey: req.bookingKey,
    });
    expect(released.state).toBe('RELEASED');
    expect(released.version).toBe(2);
    expect(await activeOccupationCount(trip.tripId)).toBe(0);

    const retry = await service.releaseHold({
      ownerId: req.ownerId,
      bookingKey: req.bookingKey,
    });
    expect(retry.state).toBe('RELEASED');
    expect(retry.version).toBe(2);

    // Replaying the create key after release is a terminal receipt, never a
    // second allocation or a reset TTL.
    const replayAfterRelease = await service.createHold(req);
    expect(replayAfterRelease.state).toBe('RELEASED');
    expect(replayAfterRelease.version).toBe(2);
    expect(await activeOccupationCount(trip.tripId)).toBe(0);

    expect(await eventTypes()).toEqual([
      'inventory.hold.held',
      'inventory.hold.released',
    ]);

    const unknownKey = randomUUID();
    const tombstone = await service.releaseHold({
      ownerId: randomUUID(),
      bookingKey: unknownKey,
    });
    expect(tombstone.state).toBe('CANCELLED');
    expect(tombstone.assignments).toEqual([]);

    const lateCreate = request(
      [leg(trip)],
      [passenger('p-late', 'token-late')],
      { ownerId: tombstone.ownerId, bookingKey: unknownKey },
    );
    const late = await service.createHold(lateCreate);
    expect(late.state).toBe('CANCELLED');
    expect(late.assignments).toEqual([]);
    expect(await activeOccupationCount(trip.tripId)).toBe(0);

    // Unknown-key release publishes no fictitious release event.
    expect(await eventTypes()).toEqual([
      'inventory.hold.held',
      'inventory.hold.released',
    ]);
  });
});

describe('MT-20 extend once safely', () => {
  it('applies a full five-minute extension to every held occupation', async () => {
    const trip = await seedTrip({ departureAt: atIn(120) });
    const req = request(
      [leg(trip)],
      [passenger('p-1', 'token-1'), passenger('p-2', 'token-2')],
    );
    const created = await service.createHold(req);

    const extended = await service.extendHold({
      ownerId: req.ownerId,
      bookingKey: req.bookingKey,
    });

    expect(extended.state).toBe('HELD');
    expect(extended.version).toBe(2);
    expect(extended.extensionUsed).toBe(true);

    const before = new Date(created.expiresAt as string).getTime();
    const after = new Date(extended.expiresAt as string).getTime();
    expect(after - before).toBe(5 * MINUTE);

    const occupations: { hold_expires_at: Date }[] = await source.query(
      `SELECT hold_expires_at
       FROM seat_occupation
       WHERE hold_id = $1 AND released_at IS NULL`,
      [created.holdId],
    );
    expect(occupations).toHaveLength(2);
    for (const occupation of occupations) {
      expect(new Date(occupation.hold_expires_at).getTime()).toBe(after);
    }

    await expectHoldError(
      service.extendHold({
        ownerId: req.ownerId,
        bookingKey: req.bookingKey,
      }),
      ErrorCode.EXTENSION_NOT_ALLOWED,
    );
  });

  it('extends every leg and occupation using the earliest cutoff', async () => {
    const outbound = await seedTrip({ departureAt: atIn(120) });
    const inbound = await seedTrip({ departureAt: atIn(32) });
    const req = request(
      [leg(outbound), leg(inbound)],
      [passenger('p-1', 'token-1'), passenger('p-2', 'token-2')],
    );
    const created = await service.createHold(req);

    const extended = await service.extendHold({
      ownerId: req.ownerId,
      bookingKey: req.bookingKey,
    });

    const before = new Date(created.expiresAt as string).getTime();
    const after = new Date(extended.expiresAt as string).getTime();
    expect(after).toBeGreaterThan(before);
    expect(after).toBeLessThan(before + 5 * MINUTE);

    const occupations: { hold_expires_at: Date }[] = await source.query(
      `SELECT hold_expires_at
       FROM seat_occupation
       WHERE hold_id = $1 AND released_at IS NULL`,
      [created.holdId],
    );
    expect(occupations).toHaveLength(4);
    for (const occupation of occupations) {
      expect(new Date(occupation.hold_expires_at).getTime()).toBe(after);
    }

    expect(await eventTypes()).toContain('inventory.hold.extended');
  });

  it('caps a partial extension at the current sales cutoff', async () => {
    const trip = await seedTrip({ departureAt: atIn(32) });
    const req = request([leg(trip)], [passenger('p-1', 'token-1')]);
    const created = await service.createHold(req);

    const extended = await service.extendHold({
      ownerId: req.ownerId,
      bookingKey: req.bookingKey,
    });

    const after = new Date(extended.expiresAt as string).getTime();
    const createdExpiry = new Date(created.expiresAt as string).getTime();
    expect(after).toBeGreaterThan(createdExpiry);
    expect(after).toBeLessThan(createdExpiry + 5 * MINUTE);
  });

  it('consumes no extension when there is no headroom', async () => {
    const trip = await seedTrip({ departureAt: atIn(20) });
    const req = request([leg(trip)], [passenger('p-1', 'token-1')]);
    const created = await service.createHold(req);

    await expectHoldError(
      service.extendHold({
        ownerId: req.ownerId,
        bookingKey: req.bookingKey,
      }),
      ErrorCode.EXTENSION_NOT_ALLOWED,
    );

    const [row]: {
      extension_used: boolean;
      version: number;
      expires_at: Date;
    }[] = await source.query(
      `SELECT extension_used, version, expires_at
       FROM seat_hold_group
       WHERE id = $1`,
      [created.holdId],
    );
    expect(row.extension_used).toBe(false);
    expect(row.version).toBe(1);
    expect(new Date(row.expires_at).toISOString()).toBe(created.expiresAt);
  });

  it('refuses to extend a released hold', async () => {
    const trip = await seedTrip({ departureAt: atIn(120) });
    const req = request([leg(trip)], [passenger('p-1', 'token-1')]);
    await service.createHold(req);
    await service.releaseHold({
      ownerId: req.ownerId,
      bookingKey: req.bookingKey,
    });

    await expectHoldError(
      service.extendHold({
        ownerId: req.ownerId,
        bookingKey: req.bookingKey,
      }),
      ErrorCode.HOLD_TERMINAL,
    );
  });
});

describe('MT-16 expiry and passenger overlap', () => {
  it('releases an expired seat immediately and emits one expiry event', async () => {
    const trip = await seedTrip({ departureAt: atIn(120), seatCount: 1 });
    const firstReq = request([leg(trip)], [passenger('p-1', 'token-1')]);
    const first = await service.createHold(firstReq);

    await source.query(
      `UPDATE seat_hold_group
       SET expires_at = clock_timestamp() - interval '1 minute'
       WHERE id = $1`,
      [first.holdId],
    );
    await source.query(
      `UPDATE seat_occupation
       SET hold_expires_at = clock_timestamp() - interval '1 minute'
       WHERE hold_id = $1`,
      [first.holdId],
    );

    const secondReq = request([leg(trip)], [passenger('p-2', 'token-2')]);
    const second = await service.createHold(secondReq);
    expect(second.state).toBe('HELD');

    const [firstOccupation]: { released_at: Date | null }[] =
      await source.query(
        `SELECT released_at FROM seat_occupation WHERE hold_id = $1`,
        [first.holdId],
      );
    expect(firstOccupation.released_at).not.toBeNull();

    const expired = await service.getHold({
      ownerId: firstReq.ownerId,
      bookingKey: firstReq.bookingKey,
    });
    expect(expired.state).toBe('EXPIRED');
    expect(expired.version).toBe(2);

    const again = await service.getHold({
      ownerId: firstReq.ownerId,
      bookingKey: firstReq.bookingKey,
    });
    expect(again.state).toBe('EXPIRED');
    expect(again.version).toBe(2);

    const events = await eventTypes();
    expect(
      events.filter((type) => type === 'inventory.hold.expired'),
    ).toHaveLength(1);
  });

  it('allows touching segments and refuses an overlapping passenger claim', async () => {
    const trip = await seedTrip({
      departureAt: atIn(120),
      seatCount: 4,
      stops: 4,
    });
    const sharedToken = 'same-canonical-passenger';

    const first = request([leg(trip, 0, 2)], [passenger('p-1', sharedToken)]);
    await service.createHold(first);

    const touching = request(
      [leg(trip, 2, 3)],
      [passenger('p-1', sharedToken)],
      { ownerId: randomUUID() },
    );
    const touchingSnapshot = await service.createHold(touching);
    expect(touchingSnapshot.state).toBe('HELD');

    const overlapping = request(
      [leg(trip, 1, 3)],
      [passenger('p-1', sharedToken)],
      { ownerId: randomUUID() },
    );
    await expectHoldError(
      service.createHold(overlapping),
      ErrorCode.PASSENGER_OVERLAP,
    );
  });
});

describe('MT-15 key reads and request validation', () => {
  it('refuses an unknown key and a key owned by another traveller', async () => {
    const trip = await seedTrip({ departureAt: atIn(120) });
    const req = request([leg(trip)], [passenger('p-1', 'token-1')]);
    await service.createHold(req);

    await expectHoldError(
      service.getHold({
        ownerId: req.ownerId,
        bookingKey: randomUUID(),
      }),
      ErrorCode.HOLD_NOT_FOUND,
    );

    await expectHoldError(
      service.getHold({
        ownerId: randomUUID(),
        bookingKey: req.bookingKey,
      }),
      ErrorCode.BOOKING_KEY_CONFLICT,
    );
  });

  it('requires exactly one identity per passenger per leg', async () => {
    const outbound = await seedTrip({ departureAt: atIn(120) });
    const inbound = await seedTrip({ departureAt: atIn(180) });
    const req = request(
      [leg(outbound), leg(inbound)],
      [passenger('p-1', 'token-1')],
    );

    req.passengers[0].identities = req.passengers[0].identities.slice(0, 1);

    await expectHoldError(service.createHold(req), ErrorCode.VALIDATION_ERROR);
  });

  it('refuses the same trip token twice within one hold', async () => {
    const trip = await seedTrip({ departureAt: atIn(120) });
    const req = request(
      [leg(trip)],
      [passenger('p-1', 'same-token'), passenger('p-2', 'same-token')],
    );

    await expectHoldError(service.createHold(req), ErrorCode.PASSENGER_OVERLAP);
  });

  it('refuses a travel class that is not offered on the trip', async () => {
    const trip = await seedTrip({ departureAt: atIn(120) });
    const req = request([leg(trip)], [passenger('p-1', 'token-1')]);
    req.legs[0].travelClassId = randomUUID();

    await expectHoldError(
      service.createHold(req),
      ErrorCode.RESOURCE_NOT_FOUND,
    );
  });
});

describe('TA-70 hold-schema rollback safety', () => {
  it('refuses before destructive SQL when protected hold data exists', async () => {
    const trip = await seedTrip({ departureAt: atIn(120) });
    const hold = await service.createHold(
      request([leg(trip)], [passenger('p-rollback', 'token-rollback')]),
    );
    const before: { groups: string; guards: string; occupations: string }[] =
      await source.query(`
        SELECT
          (SELECT count(*)::text FROM seat_hold_group) AS groups,
          (SELECT count(*)::text FROM seat_hold_owner_guard) AS guards,
          (SELECT count(*)::text FROM seat_occupation WHERE hold_id IS NOT NULL) AS occupations
      `);
    const runner = source.createQueryRunner();
    await runner.connect();
    try {
      await expect(
        new CreateHoldCore1794600000008().down(runner),
      ).rejects.toThrow('Cannot roll back hold storage');
    } finally {
      await runner.release();
    }
    expect(
      await source.query(`
        SELECT
          (SELECT count(*)::text FROM seat_hold_group) AS groups,
          (SELECT count(*)::text FROM seat_hold_owner_guard) AS guards,
          (SELECT count(*)::text FROM seat_occupation WHERE hold_id IS NOT NULL) AS occupations
      `),
    ).toEqual(before);
    const [schema]: { groupTable: string; holdColumn: string }[] =
      await source.query(`
        SELECT to_regclass('seat_hold_group')::text AS "groupTable",
               (SELECT column_name FROM information_schema.columns
                WHERE table_schema = current_schema()
                  AND table_name = 'seat_occupation'
                  AND column_name = 'hold_id') AS "holdColumn"
      `);
    expect(schema).toEqual({
      groupTable: 'seat_hold_group',
      holdColumn: 'hold_id',
    });
    expect(
      await service.getHold({
        ownerId: hold.ownerId,
        bookingKey: hold.bookingKey,
      }),
    ).toMatchObject({ holdId: hold.holdId, state: 'HELD' });
  });

  it('allows an empty schema rollback and remains reversible through transaction rollback', async () => {
    const runner = source.createQueryRunner();
    await runner.connect();
    await runner.startTransaction();
    try {
      await new CreateHoldCore1794600000008().down(runner);
      const [inside]: {
        groupTable: string | null;
        holdColumn: string | null;
      }[] = await runner.query(`
          SELECT to_regclass('seat_hold_group')::text AS "groupTable",
                 (SELECT column_name FROM information_schema.columns
                  WHERE table_schema = current_schema()
                    AND table_name = 'seat_occupation'
                    AND column_name = 'hold_id') AS "holdColumn"
        `);
      expect(inside).toEqual({ groupTable: null, holdColumn: null });
    } finally {
      await runner.rollbackTransaction();
      await runner.release();
    }
    const [restored]: { groupTable: string }[] = await source.query(
      `SELECT to_regclass('seat_hold_group')::text AS "groupTable"`,
    );
    expect(restored.groupTable).toBe('seat_hold_group');
  });
});

describe('hold lifecycle events and schema guards', () => {
  it('keeps tokens and personal data out of the committed event', async () => {
    const trip = await seedTrip({ departureAt: atIn(120) });
    const req = request([leg(trip)], [passenger('p-1', 'secret-token')]);
    await service.createHold(req);

    const [row]: { payload: string }[] = await source.query(
      `SELECT payload::text AS payload FROM outbox_event`,
    );
    expect(row.payload).not.toContain('secret-token');
    expect(row.payload).not.toContain('nationalId');
    expect(row.payload).not.toContain('passengerToken');
    expect(row.payload).toContain(req.bookingKey);
    expect(row.payload).toContain(req.ownerId);
  });

  it('allows only one unresolved held group per owner', async () => {
    const ownerId = randomUUID();
    const insert = (id: string, key: string): Promise<unknown> =>
      source.query(
        `INSERT INTO seat_hold_group
           (id, booking_key, owner_id, request_fingerprint, state, version,
            extension_used, expires_at, created_at, updated_at)
         VALUES ($1, $2, $3, 'fp', 'held', 1, false,
                 clock_timestamp() + interval '15 minutes',
                 clock_timestamp(), clock_timestamp())`,
        [id, key, ownerId],
      );

    await insert(randomUUID(), 'owner-key-1');
    await expect(insert(randomUUID(), 'owner-key-2')).rejects.toThrow(
      /uq_seat_hold_group_owner_active/,
    );
  });

  it('refuses overlapping passenger tokens at the database level', async () => {
    const trip = await seedTrip({ departureAt: atIn(120), seatCount: 2 });
    const holdId = randomUUID();

    await source.query(
      `INSERT INTO seat_hold_group
         (id, booking_key, owner_id, request_fingerprint, state, version,
          extension_used, expires_at, created_at, updated_at)
       VALUES ($1, 'passenger-guard-key', $2, 'fp', 'held', 1, false,
               clock_timestamp() + interval '15 minutes',
               clock_timestamp(), clock_timestamp())`,
      [holdId, randomUUID()],
    );

    const insertOccupation = (
      seatId: string,
      segment: string,
    ): Promise<unknown> =>
      source.query(
        `INSERT INTO seat_occupation
           (id, trip_seat_id, trip_id, segment, state, hold_expires_at,
            hold_id, owner_id, passenger_ref, passenger_token,
            passenger_key_version, created_at, updated_at)
         VALUES (gen_random_uuid(), $1, $2, $3::int4range, 'held',
                 clock_timestamp() + interval '15 minutes',
                 $4, $5, 'p-1', 'same-token', 1,
                 clock_timestamp(), clock_timestamp())`,
        [seatId, trip.tripId, segment, holdId, randomUUID()],
      );

    await insertOccupation(trip.seatIds[0], '[0,2)');
    await expect(insertOccupation(trip.seatIds[1], '[1,2)')).rejects.toThrow(
      /excl_seat_occupation_passenger_overlap/,
    );
  });
});

async function makeDue(holdId: string, age = '30 seconds'): Promise<void> {
  await source.transaction(async (manager) => {
    const [row]: { deadline: Date }[] = await manager.query(
      `SELECT clock_timestamp() - $1::interval AS deadline`,
      [age],
    );
    await manager.query(
      `UPDATE seat_hold_group SET expires_at = $2 WHERE id = $1`,
      [holdId, row.deadline],
    );
    await manager.query(
      `UPDATE seat_occupation SET hold_expires_at = $2 WHERE hold_id = $1`,
      [holdId, row.deadline],
    );
  });
}

describe('durable whole-hold expiry batches', () => {
  it('expires every passenger and leg once while preserving sold occupations', async () => {
    const outbound = await seedTrip({ departureAt: atIn(120) });
    const inbound = await seedTrip({ departureAt: atIn(180) });
    await occupySold(outbound.seatIds[3], outbound.tripId);
    const req = request(
      [leg(outbound), leg(inbound)],
      [passenger('p-1', 'token-1'), passenger('p-2', 'token-2')],
    );
    const hold = await service.createHold(req);
    await makeDue(hold.holdId);

    expect(await service.expireDueHolds()).toBe(1);
    expect(await service.expireDueHolds()).toBe(0);
    expect(await activeOccupationCount(outbound.tripId)).toBe(1);
    expect(await activeOccupationCount(inbound.tripId)).toBe(0);
    const snapshot = await service.getHold({
      ownerId: req.ownerId,
      bookingKey: req.bookingKey,
    });
    expect(snapshot).toMatchObject({ state: 'EXPIRED', version: 2 });
    expect(snapshot.assignments).toHaveLength(4);

    const [event]: { payload: Record<string, unknown> }[] = await source.query(
      `SELECT payload FROM outbox_event WHERE event_type = 'inventory.hold.expired'`,
    );
    expect(event.payload).toMatchObject({
      holdId: hold.holdId,
      aggregateVersion: 2,
      state: 'EXPIRED',
      reason: 'expired',
    });
    expect(event.payload.legs).toHaveLength(2);
    expect(
      (await eventTypes()).filter((type) => type === 'inventory.hold.expired'),
    ).toHaveLength(1);
  });

  it('leaves future deadlines untouched and limits each batch', async () => {
    const trip = await seedTrip({ departureAt: atIn(120) });
    const holds = [];
    for (let index = 0; index < 3; index += 1) {
      holds.push(
        await service.createHold(
          request([leg(trip)], [passenger(`p-${index}`, `token-${index}`)]),
        ),
      );
    }
    await makeDue(holds[0].holdId);
    await makeDue(holds[1].holdId);
    expect(await service.expireDueHolds(1)).toBe(1);
    expect(await service.expireDueHolds(1)).toBe(1);
    expect(await service.expireDueHolds(1)).toBe(0);
    const [future]: { state: string; version: number }[] = await source.query(
      `SELECT state, version FROM seat_hold_group WHERE id = $1`,
      [holds[2].holdId],
    );
    expect(future).toEqual({ state: 'held', version: 1 });
  });

  it('uses SKIP LOCKED and recovers a rolled-back claim', async () => {
    const trip = await seedTrip({ departureAt: atIn(120) });
    const hold = await service.createHold(
      request([leg(trip)], [passenger('p-1', 'token-1')]),
    );
    await makeDue(hold.holdId);
    const uow = new TypeOrmUnitOfWork(new DataSourceInitializer(source));
    let claimed: () => void = () => {};
    let release: () => void = () => {};
    const locked = new Promise<void>((resolve) => {
      claimed = resolve;
    });
    const finish = new Promise<void>((resolve) => {
      release = resolve;
    });
    const transaction = uow.withTransaction(async (ctx) => {
      expect(await new HoldCoreRepository().lockDueHolds(ctx, 1)).toHaveLength(
        1,
      );
      claimed();
      await finish;
      throw new Error('simulated worker rollback');
    });
    const rolledBack = expect(transaction).rejects.toThrow(
      'simulated worker rollback',
    );
    await locked;
    try {
      expect(await service.expireDueHolds(1)).toBe(0);
    } finally {
      release();
      await rolledBack;
    }
    expect(await service.expireDueHolds(1)).toBe(1);
  });

  it('rolls back all releases when durable event insertion fails', async () => {
    const trip = await seedTrip({ departureAt: atIn(120) });
    const hold = await service.createHold(
      request([leg(trip)], [passenger('p-1', 'token-1')]),
    );
    await makeDue(hold.holdId);
    const failing = new HoldCoreService(
      new HoldCoreRepository(),
      new TypeOrmUnitOfWork(new DataSourceInitializer(source)),
      {
        append: async () => {},
        appendBatch: async () => {
          throw new Error('outbox unavailable');
        },
      },
    );
    await expect(failing.expireDueHolds()).rejects.toThrow(
      'outbox unavailable',
    );
    const [head]: {
      state: string;
      version: number;
      released_at: Date | null;
    }[] = await source.query(
      `SELECT state, version, released_at FROM seat_hold_group WHERE id = $1`,
      [hold.holdId],
    );
    expect(head).toEqual({ state: 'held', version: 1, released_at: null });
    expect(await activeOccupationCount(trip.tripId)).toBe(1);
    expect(await eventTypes()).toEqual(['inventory.hold.held']);
    expect(await service.expireDueHolds()).toBe(1);
  });

  it('emits expiry after request-path reclamation, even after occupation cleanup', async () => {
    const trip = await seedTrip({ departureAt: atIn(120), seatCount: 1 });
    const first = await service.createHold(
      request([leg(trip)], [passenger('p-1', 'same-token')]),
    );
    await makeDue(first.holdId);
    const second = await service.createHold(
      request([leg(trip)], [passenger('p-2', 'same-token')]),
    );
    expect(second.state).toBe('HELD');
    await source.query(`DELETE FROM seat_occupation WHERE hold_id = $1`, [
      first.holdId,
    ]);

    expect(await service.expireDueHolds()).toBe(1);
    expect(await activeOccupationCount(trip.tripId)).toBe(1);
    expect(
      (await eventTypes()).filter((type) => type === 'inventory.hold.expired'),
    ).toHaveLength(1);
  });

  it('two independent runners drain an hour-aged backlog without duplicate events', async () => {
    const trip = await seedTrip({ departureAt: atIn(120) });
    for (let index = 0; index < 4; index += 1) {
      const hold = await service.createHold(
        request([leg(trip)], [passenger(`p-${index}`, `token-${index}`)]),
      );
      await makeDue(hold.holdId, '1 hour');
    }
    const restarted = new HoldCoreService(
      new HoldCoreRepository(),
      new TypeOrmUnitOfWork(new DataSourceInitializer(source)),
      new TypeOrmOutboxRepository(new DataSourceInitializer(source)),
    );
    const counts = await Promise.all([
      service.expireDueHolds(2),
      restarted.expireDueHolds(2),
    ]);
    expect(counts.reduce((sum, count) => sum + count, 0)).toBe(4);
    expect(await restarted.expireDueHolds()).toBe(0);
    expect(await activeOccupationCount(trip.tripId)).toBe(0);
    const [countsRow]: { events: string; holds: string }[] = await source.query(
      `SELECT count(*)::text AS events, count(DISTINCT payload->>'holdId')::text AS holds
       FROM outbox_event WHERE event_type = 'inventory.hold.expired'`,
    );
    expect(countsRow).toEqual({ events: '4', holds: '4' });
  });

  it('expiry, release, and expired extension races cannot resurrect ownership', async () => {
    const trip = await seedTrip({ departureAt: atIn(120) });
    const req = request([leg(trip)], [passenger('p-1', 'token-1')]);
    const hold = await service.createHold(req);
    await makeDue(hold.holdId);
    const key = { ownerId: req.ownerId, bookingKey: req.bookingKey };
    const results = await Promise.allSettled([
      service.expireDueHolds(),
      service.releaseHold(key),
      service.extendHold(key),
    ]);
    expect(results[2]).toMatchObject({
      status: 'rejected',
      reason: { code: ErrorCode.HOLD_TERMINAL },
    });
    expect(await service.getHold(key)).toMatchObject({
      state: 'EXPIRED',
      version: 2,
    });
    expect(await activeOccupationCount(trip.tripId)).toBe(0);
    expect(
      (await eventTypes()).filter((type) => type === 'inventory.hold.expired'),
    ).toHaveLength(1);
  });

  it('two concurrent extensions accept exactly one five-minute increase', async () => {
    const trip = await seedTrip({ departureAt: atIn(120) });
    const req = request([leg(trip)], [passenger('p-1', 'token-1')]);
    const hold = await service.createHold(req);
    const key = { ownerId: req.ownerId, bookingKey: req.bookingKey };
    const results = await Promise.allSettled([
      service.extendHold(key),
      service.extendHold(key),
    ]);
    expect(
      results.filter((result) => result.status === 'fulfilled'),
    ).toHaveLength(1);
    expect(
      results.filter((result) => result.status === 'rejected'),
    ).toMatchObject([{ reason: { code: ErrorCode.EXTENSION_NOT_ALLOWED } }]);
    const snapshot = await service.getHold(key);
    expect(
      new Date(snapshot.expiresAt as string).getTime() -
        new Date(hold.expiresAt as string).getTime(),
    ).toBe(5 * MINUTE);
    expect(await service.expireDueHolds()).toBe(0);
    expect(
      (await eventTypes()).filter((type) => type === 'inventory.hold.extended'),
    ).toHaveLength(1);
  });
});

describe('original TA-70 concurrent segment acceptance', () => {
  it('enforces passenger overlap across accounts and travel classes with free seats', async () => {
    const trip = await seedTrip({
      departureAt: atIn(120),
      seatCount: 4,
      stops: 4,
    });
    const secondClass = randomUUID();
    const secondCoach = randomUUID();
    await source.query(
      `INSERT INTO trip_coach (id, trip_id, coach_number, position, travel_class_id, travel_class_name_en, travel_class_name_ar)
       VALUES ($1, $2, 2, 2, $3, 'Second class', 'Second class')`,
      [secondCoach, trip.tripId, secondClass],
    );
    for (const number of [1, 2]) {
      await source.query(
        `INSERT INTO trip_seat (id, trip_id, trip_coach_id, seat_number, travel_class_id, row_number, side, seat_index_in_side)
         VALUES ($1, $2, $3, $4, $5, 1, 'left', $6)`,
        [
          randomUUID(),
          trip.tripId,
          secondCoach,
          String(number),
          secondClass,
          number - 1,
        ],
      );
    }
    const results = await Promise.allSettled([
      service.createHold(
        request([leg(trip, 0, 3)], [passenger('p-first', 'same-canonical-id')]),
      ),
      service.createHold(
        request(
          [{ ...leg(trip, 1, 2), travelClassId: secondClass }],
          [passenger('p-second', 'same-canonical-id')],
        ),
      ),
    ]);
    expect(
      results.filter((result) => result.status === 'fulfilled'),
    ).toHaveLength(1);
    expect(
      results.filter((result) => result.status === 'rejected'),
    ).toMatchObject([{ reason: { code: ErrorCode.PASSENGER_OVERLAP } }]);
    expect(await activeOccupationCount(trip.tripId)).toBe(1);
  });

  it('counts a sold passenger identity as well as active holds across accounts', async () => {
    const trip = await seedTrip({ departureAt: atIn(120), seatCount: 4 });
    const req = request([leg(trip)], [passenger('p-new', 'same-canonical-id')]);
    await source.query(
      `INSERT INTO seat_occupation (id, trip_seat_id, trip_id, segment, state, owner_id, passenger_ref, passenger_token, passenger_key_version)
       VALUES ($1, $2, $3, '[0,2)'::int4range, 'sold', $4, 'p-sold', $5, 1)`,
      [
        randomUUID(),
        trip.seatIds[0],
        trip.tripId,
        randomUUID(),
        req.passengers[0].identities[0].passengerToken,
      ],
    );
    await expectHoldError(service.createHold(req), ErrorCode.PASSENGER_OVERLAP);
    expect(await activeOccupationCount(trip.tripId)).toBe(1);
    expect(await eventTypes()).toEqual([]);
  });

  it('allows two touching segments on the same single seat', async () => {
    const trip = await seedTrip({
      departureAt: atIn(120),
      seatCount: 1,
      stops: 4,
    });
    const snapshots = await Promise.all([
      service.createHold(
        request([leg(trip, 0, 2)], [passenger('p-a', 'token-a')]),
      ),
      service.createHold(
        request([leg(trip, 2, 3)], [passenger('p-b', 'token-b')]),
      ),
    ]);
    expect(snapshots.every((hold) => hold.state === 'HELD')).toBe(true);
    expect(snapshots.map((hold) => hold.assignments[0].tripSeatId)).toEqual([
      trip.seatIds[0],
      trip.seatIds[0],
    ]);
  });

  it('refuses one of two intersecting segments on the same single seat', async () => {
    const trip = await seedTrip({
      departureAt: atIn(120),
      seatCount: 1,
      stops: 4,
    });
    const results = await Promise.allSettled([
      service.createHold(
        request([leg(trip, 0, 3)], [passenger('p-a', 'token-a')]),
      ),
      service.createHold(
        request([leg(trip, 1, 2)], [passenger('p-b', 'token-b')]),
      ),
    ]);
    expect(
      results.filter((result) => result.status === 'fulfilled'),
    ).toHaveLength(1);
    expect(
      results.filter((result) => result.status === 'rejected'),
    ).toMatchObject([{ reason: { code: ErrorCode.SEAT_TAKEN } }]);
  });

  it('refuses the same passenger across accounts before seat shortage', async () => {
    const trip = await seedTrip({
      departureAt: atIn(120),
      seatCount: 4,
      stops: 4,
    });
    const results = await Promise.allSettled([
      service.createHold(
        request([leg(trip, 0, 3)], [passenger('p-a', 'same-canonical-id')]),
      ),
      service.createHold(
        request([leg(trip, 1, 2)], [passenger('p-b', 'same-canonical-id')]),
      ),
    ]);
    expect(
      results.filter((result) => result.status === 'fulfilled'),
    ).toHaveLength(1);
    expect(
      results.filter((result) => result.status === 'rejected'),
    ).toMatchObject([{ reason: { code: ErrorCode.PASSENGER_OVERLAP } }]);
    expect(await activeOccupationCount(trip.tripId)).toBe(1);
  });
});

describe('TA-70 authoritative legacy-data activation gate', () => {
  async function readiness(): Promise<boolean> {
    const previous = process.env.HOLD_CREATION_ENABLED;
    process.env.HOLD_CREATION_ENABLED = 'true';
    try {
      return await new HoldCreationGuard(
        new DataSourceInitializer(source),
        new SchemaReadinessGate(),
        { hasCompleted: true } as never,
      ).canActivate();
    } finally {
      if (previous === undefined) delete process.env.HOLD_CREATION_ENABLED;
      else process.env.HOLD_CREATION_ENABLED = previous;
    }
  }

  it('refuses unidentified live sold data without deleting it', async () => {
    const trip = await seedTrip({ departureAt: atIn(120) });
    await occupySold(trip.seatIds[0], trip.tripId);
    await expect(readiness()).rejects.toMatchObject({ error: { code: 14 } });
    expect(await activeOccupationCount(trip.tripId)).toBe(1);
    await source.query(
      `UPDATE seat_occupation SET released_at = clock_timestamp() WHERE trip_id = $1`,
      [trip.tripId],
    );
    await expect(readiness()).resolves.toBe(true);
  });

  it('does not let an expired anonymous legacy hold block admission or seat reuse', async () => {
    const trip = await seedTrip({ departureAt: atIn(120), seatCount: 1 });
    await source.query(
      `INSERT INTO seat_occupation (id, trip_seat_id, trip_id, segment, state, reference_id, hold_expires_at)
       VALUES ($1, $2, $3, '[0,2)'::int4range, 'held', $4, clock_timestamp() - interval '30 seconds')`,
      [randomUUID(), trip.seatIds[0], trip.tripId, randomUUID()],
    );
    await expect(readiness()).resolves.toBe(true);
    const hold = await service.createHold(
      request([leg(trip)], [passenger('p-new', 'new-canonical-id')]),
    );
    expect(hold.state).toBe('HELD');
    expect(hold.assignments[0].tripSeatId).toBe(trip.seatIds[0]);
    expect(await activeOccupationCount(trip.tripId)).toBe(1);
  });
});

async function existingPlan(tripId: string): Promise<SeatPlan> {
  const [trip]: {
    trainId: string;
    trainNumber: number;
    serviceDate: string;
    timetableVersion: number;
  }[] = await source.query(
    `SELECT train_id AS "trainId", train_number AS "trainNumber", service_date::text AS "serviceDate", timetable_version AS "timetableVersion"
     FROM inventory_trip WHERE id = $1`,
    [tripId],
  );
  const stops = await source.query(
    `SELECT station_id AS "stationId", position, arrival_at AS "arrivalAt", departure_at AS "departureAt" FROM trip_stop WHERE trip_id = $1 ORDER BY position`,
    [tripId],
  );
  const coaches = await source.query(
    `SELECT id, coach_number AS "coachNumber", position, travel_class_id AS "travelClassId", travel_class_name_en AS "travelClassNameEn", travel_class_name_ar AS "travelClassNameAr" FROM trip_coach WHERE trip_id = $1`,
    [tripId],
  );
  const seats = await source.query(
    `SELECT id, trip_coach_id AS "coachId", seat_number AS "seatNumber", travel_class_id AS "travelClassId", row_number AS "rowNumber", side, seat_index_in_side AS "seatIndexInSide" FROM trip_seat WHERE trip_id = $1`,
    [tripId],
  );
  return {
    ...trip,
    tripId,
    timetableVersion: trip.timetableVersion + 1,
    stops,
    coaches,
    seats,
    capacityMismatch: null,
  };
}

describe('hold promises during timetable republication', () => {
  it('refuses a departure change that would move sales cutoff before promised expiry', async () => {
    const trip = await seedTrip({ departureAt: atIn(120) });
    const hold = await service.createHold(
      request([leg(trip)], [passenger('p-1', 'token-1')]),
    );
    const plan = await existingPlan(trip.tripId);
    plan.stops[0].departureAt = new Date(
      new Date(hold.expiresAt as string).getTime() + 14 * MINUTE,
    );
    const uow = new TypeOrmUnitOfWork(new DataSourceInitializer(source));
    const outcome = await uow.withTransaction((ctx) =>
      new SeatPlanRepository().apply(ctx, plan),
    );
    expect(outcome).toMatchObject({
      kind: 'refused',
      reason: 'hold-promise-changed',
    });
    const [persisted]: { timetable_version: number }[] = await source.query(
      `SELECT timetable_version FROM inventory_trip WHERE id = $1`,
      [trip.tripId],
    );
    expect(persisted.timetable_version).toBe(1);
  });

  it('refuses reclassification of a live assigned seat and preserves its receipt', async () => {
    const trip = await seedTrip({ departureAt: atIn(120) });
    const req = request([leg(trip)], [passenger('p-1', 'token-1')]);
    const hold = await service.createHold(req);
    const plan = await existingPlan(trip.tripId);
    const changedClass = randomUUID();
    plan.coaches[0].travelClassId = changedClass;
    plan.seats.forEach((seat) => {
      seat.travelClassId = changedClass;
    });
    const uow = new TypeOrmUnitOfWork(new DataSourceInitializer(source));
    expect(
      await uow.withTransaction((ctx) =>
        new SeatPlanRepository().apply(ctx, plan),
      ),
    ).toMatchObject({ kind: 'refused', reason: 'hold-promise-changed' });
    expect(
      (
        await service.getHold({
          ownerId: req.ownerId,
          bookingKey: req.bookingKey,
        })
      ).assignments,
    ).toEqual(hold.assignments);
  });

  it('allows safe layout changes after expiry and still publishes whole-hold expiry', async () => {
    const trip = await seedTrip({ departureAt: atIn(120) });
    const req = request([leg(trip)], [passenger('p-1', 'token-1')]);
    const hold = await service.createHold(req);
    await makeDue(hold.holdId);
    const plan = await existingPlan(trip.tripId);
    plan.seats = plan.seats.filter(
      (seat) => seat.id !== hold.assignments[0].tripSeatId,
    );
    const uow = new TypeOrmUnitOfWork(new DataSourceInitializer(source));
    expect(
      await uow.withTransaction((ctx) =>
        new SeatPlanRepository().apply(ctx, plan),
      ),
    ).toMatchObject({ kind: 'created' });
    expect(await service.expireDueHolds()).toBe(1);
    expect(
      (
        await service.getHold({
          ownerId: req.ownerId,
          bookingKey: req.bookingKey,
        })
      ).assignments,
    ).toEqual(hold.assignments);
    expect(
      (await eventTypes()).filter((type) => type === 'inventory.hold.expired'),
    ).toHaveLength(1);
  });
});
