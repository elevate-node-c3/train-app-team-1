import type { DataSource } from 'typeorm';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { DataSourceInitializer } from '../../libs/common/src/persistence/data-source-initializer.js';
import { TypeOrmUnitOfWork } from '../../libs/common/src/persistence/typeorm-unit-of-work.js';

import { segmentOf } from '../../apps/inventory/src/modules/seats/segment.js';
import { seatPlanFrom, type SeatPlan } from '../../apps/inventory/src/modules/seats/seat-plan.js';
import { sixStopPayload } from '../../apps/inventory/src/modules/seats/seat-plan.fixture.js';
import { SeatPlanRepository } from '../../apps/inventory/src/modules/seats/seat-plan.repository.js';

import {
  closeInventoryDataSource,
  inventoryDataSource,
  truncateInventory,
} from './support/inventory-database.js';
import { occupy as occupySeat, release as releaseSeat } from './support/inventory-fixture.js';

let source: DataSource;
let repository: SeatPlanRepository;
let unitOfWork: TypeOrmUnitOfWork;

beforeEach(async () => {
  source = await inventoryDataSource();
  await truncateInventory(source);
  repository = new SeatPlanRepository();
  unitOfWork = new TypeOrmUnitOfWork(new DataSourceInitializer(source));
});

afterAll(async () => {
  await closeInventoryDataSource();
});

function apply(plan: SeatPlan) {
  return unitOfWork.withTransaction((ctx) => repository.apply(ctx, plan));
}

function close(tripId: string) {
  return unitOfWork.withTransaction((ctx) => repository.close(ctx, tripId));
}

async function countRows(table: string): Promise<number> {
  const [{ count }] = await source.query(`SELECT count(*)::int AS count FROM ${table}`);
  return count;
}

async function tripVersion(): Promise<number> {
  const [row] = await source.query(
    `SELECT timetable_version AS "timetableVersion" FROM inventory_trip LIMIT 1`,
  );
  return row.timetableVersion;
}

async function tripStatus(): Promise<string> {
  const [row] = await source.query(`SELECT status FROM inventory_trip LIMIT 1`);
  return row.status;
}

/** A single row sorted by seat_number so coach-two's seats are predictable. */
async function seatIdByCoachAndNumber(coachNumber: number, seatNumber: number): Promise<string> {
  const [row] = await source.query(
    `SELECT ts.id AS "id" FROM trip_seat ts JOIN trip_coach tc ON tc.id = ts.trip_coach_id
     WHERE tc.coach_number = $1 AND ts.seat_number = $2`,
    [coachNumber, seatNumber],
  );
  return row.id;
}

describe('SeatPlanRepository.apply', () => {
  it('creates every seat of every coach, and counts them by class', async () => {
    const payload = sixStopPayload();
    const plan = seatPlanFrom(payload);
    const [firstClass, secondClass] = payload.coaches.map((coach) => coach.travelClass.id);

    const outcome = await apply(plan);

    expect(outcome).toEqual({
      kind: 'created',
      seatCount: 20,
      seatCountByClass: { [firstClass]: 10, [secondClass]: 10 },
    });
    expect(await countRows('trip_seat')).toBe(20);
    expect(await countRows('trip_stop')).toBe(6);
  });

  it('is idempotent when the same plan is applied twice', async () => {
    const plan = seatPlanFrom(sixStopPayload());

    await apply(plan);
    await apply(plan);

    expect(await countRows('trip_seat')).toBe(20);
    expect(await countRows('trip_coach')).toBe(2);
  });

  it('writes nothing at all when one insert fails', async () => {
    // All or nothing: a half-built trip must never exist. Force a genuine
    // primary-key collision (not a natural-key conflict ON CONFLICT would
    // absorb) by giving the last seat the first seat's id.
    const plan = seatPlanFrom(sixStopPayload());
    const collidingSeats = [...plan.seats];
    collidingSeats[collidingSeats.length - 1] = {
      ...collidingSeats[collidingSeats.length - 1],
      id: collidingSeats[0].id,
    };
    const planWhoseLastSeatCollides: SeatPlan = { ...plan, seats: collidingSeats };

    await expect(apply(planWhoseLastSeatCollides)).rejects.toThrow();

    expect(await countRows('inventory_trip')).toBe(0);
    expect(await countRows('trip_seat')).toBe(0);
    expect(await countRows('trip_coach')).toBe(0);
    expect(await countRows('trip_stop')).toBe(0);
  });

  it('skips a publication older than the trip it finds', async () => {
    const plan = seatPlanFrom(sixStopPayload());

    await apply({ ...plan, timetableVersion: 2 });
    expect(await apply({ ...plan, timetableVersion: 1 })).toEqual({
      kind: 'skipped',
      reason: 'stale-version',
    });
    expect(await tripVersion()).toBe(2);
  });

  it('skips a publication at the version it already holds', async () => {
    // >=, spec §6.10
    const plan = seatPlanFrom(sixStopPayload());

    await apply({ ...plan, timetableVersion: 2 });
    expect(await apply({ ...plan, timetableVersion: 2 })).toEqual({
      kind: 'skipped',
      reason: 'stale-version',
    });
    expect(await tripVersion()).toBe(2);
  });

  it('never reopens a closed trip', async () => {
    const plan = seatPlanFrom(sixStopPayload());

    await apply({ ...plan, timetableVersion: 1 });
    await close(plan.tripId);
    await apply({ ...plan, timetableVersion: 2 });

    expect(await tripStatus()).toBe('closed');
  });

  it('deletes a coach the new layout drops when nothing occupies it', async () => {
    const payload = sixStopPayload();
    const plan = seatPlanFrom(payload);
    const planWithoutCoachTwo = seatPlanFrom({ ...payload, coaches: [payload.coaches[0]] });

    await apply({ ...plan, timetableVersion: 1 });
    await apply({ ...planWithoutCoachTwo, timetableVersion: 2 });

    expect(await countRows('trip_seat')).toBe(10);
    expect(await countRows('trip_coach')).toBe(1);
  });

  it('refuses to drop a coach holding an active occupation', async () => {
    const payload = sixStopPayload();
    const plan = seatPlanFrom(payload);
    const planWithoutCoachTwo = seatPlanFrom({ ...payload, coaches: [payload.coaches[0]] });

    await apply({ ...plan, timetableVersion: 1 });
    const seatInCoachTwo = await seatIdByCoachAndNumber(2, 1);
    await occupySeat(source, seatInCoachTwo, plan.tripId, segmentOf(0, 2), 'held', new Date(Date.now() + 60 * 60_000));

    const outcome = await apply({ ...planWithoutCoachTwo, timetableVersion: 2 });

    expect(outcome.kind).toBe('refused');
    if (outcome.kind === 'refused') {
      expect(outcome.occupiedSeatNumbers).toContain('1');
    }
    expect(await countRows('trip_seat')).toBe(20);
    expect(await tripVersion()).toBe(1);
  });

  it('drops a coach whose only occupation was released', async () => {
    // released_at IS NOT NULL does not protect the seat.
    const payload = sixStopPayload();
    const plan = seatPlanFrom(payload);
    const planWithoutCoachTwo = seatPlanFrom({ ...payload, coaches: [payload.coaches[0]] });

    await apply({ ...plan, timetableVersion: 1 });
    const seatInCoachTwo = await seatIdByCoachAndNumber(2, 1);
    const occupationId = await occupySeat(
      source,
      seatInCoachTwo,
      plan.tripId,
      segmentOf(0, 2),
      'held',
      new Date(Date.now() + 60 * 60_000),
    );
    await releaseSeat(source, occupationId);

    const outcome = await apply({ ...planWithoutCoachTwo, timetableVersion: 2 });

    expect(outcome.kind).toBe('created');
    expect(await countRows('trip_seat')).toBe(10);
  });

  it('lands the newer version when two versions are applied concurrently', async () => {
    // Review Focus 2: the version check is read-then-write — a bare SELECT
    // then UPDATE would lose this race intermittently. The guard locks the
    // trip row (SELECT ... FOR UPDATE) so the two applies serialize here.
    const plan = seatPlanFrom(sixStopPayload());

    await apply({ ...plan, timetableVersion: 1 });
    await Promise.all([
      apply({ ...plan, timetableVersion: 3 }),
      apply({ ...plan, timetableVersion: 2 }),
    ]);

    expect(await tripVersion()).toBe(3);
  });
});
