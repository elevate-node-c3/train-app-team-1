import { randomUUID } from 'node:crypto';
import type { DataSource } from 'typeorm';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { DataSourceInitializer } from '../../libs/common/src/persistence/data-source-initializer.js';
import { TypeOrmUnitOfWork } from '../../libs/common/src/persistence/typeorm-unit-of-work.js';

import { segmentOf } from '../../apps/inventory/src/modules/seats/segment.js';
import { seatPlanFrom, type SeatPlan } from '../../apps/inventory/src/modules/seats/seat-plan.js';
import { sixStopPayload, twoStopPayload } from '../../apps/inventory/src/modules/seats/seat-plan.fixture.js';
import { SeatPlanRepository } from '../../apps/inventory/src/modules/seats/seat-plan.repository.js';
import {
  AvailabilityRepository,
} from '../../apps/inventory/src/modules/seats/availability.repository.js';
import type { AvailabilityQuery } from '../../apps/inventory/src/modules/seats/availability.repository.js';
import {
  AvailabilityService,
  SeatSegmentOrderError,
  SeatUnknownStationError,
} from '../../apps/inventory/src/modules/seats/availability.service.js';

import {
  closeInventoryDataSource,
  countStatements,
  inventoryDataSource,
  truncateInventory,
} from './support/inventory-database.js';
import { occupy as occupySeat, release as releaseSeat, seedSixStopTrip, SIX_STOP_TRIP } from './support/inventory-fixture.js';

// Ramsis 0, Banha 1, Tanta 2, Damnhour 3, Sidi Gaber 4, ElRaml 5.
const tripId = SIX_STOP_TRIP.tripId;
const seat44 = SIX_STOP_TRIP.seatIds[0];
const [firstClass] = SIX_STOP_TRIP.travelClassIds;
const [ramsis, banha, tanta, , sidiGaber, elRaml] = SIX_STOP_TRIP.stationIds;
const cairo = ramsis;
const alexandria = elRaml;
const aswan = randomUUID();
const classWithNoCoaches = randomUUID();
const inAnHour = new Date(Date.now() + 60 * 60_000);
const inThePast = new Date(Date.now() - 60 * 60_000);

let source: DataSource;
let planRepository: SeatPlanRepository;
let unitOfWork: TypeOrmUnitOfWork;
let repository: AvailabilityRepository;
let service: AvailabilityService;

beforeEach(async () => {
  source = await inventoryDataSource();
  await truncateInventory(source);
  await seedSixStopTrip(source);

  planRepository = new SeatPlanRepository();
  unitOfWork = new TypeOrmUnitOfWork(new DataSourceInitializer(source));
  repository = new AvailabilityRepository(source);
  service = new AvailabilityService(repository);
});

afterAll(async () => {
  await closeInventoryDataSource();
});

async function availability(
  originStationId: string,
  destinationStationId: string,
  travelClassId: string,
): Promise<number> {
  return availabilityOn(tripId, originStationId, destinationStationId, travelClassId);
}

async function availabilityOn(
  forTripId: string,
  originStationId: string,
  destinationStationId: string,
  travelClassId: string,
): Promise<number> {
  const [result] = await service.availabilityFor([
    { tripId: forTripId, originStationId, destinationStationId, travelClassId },
  ]);
  return result.availableSeats;
}

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

/** Applies a plan through the real transactional path, not raw SQL. */
async function apply(plan: SeatPlan): Promise<void> {
  await unitOfWork.withTransaction((ctx) => planRepository.apply(ctx, plan));
}

/** A fresh six-stop trip built through seatPlanFrom, used by the two-stop and overnight tests. */
function tripPayload(overrides: Partial<ReturnType<typeof sixStopPayload>>) {
  return { ...sixStopPayload(), tripId: randomUUID(), ...overrides };
}

describe('segment availability', () => {
  it('counts every seat of the class when nothing is occupied', async () => {
    expect(await availability(cairo, alexandria, firstClass)).toBe(10);
  });

  it('frees a seat for the stretch beyond the one it is held for', async () => {
    // Seat 44 held Ramsis -> Tanta.
    await occupy(seat44, segmentOf(0, 2), 'held', inAnHour);

    expect(await availability(tanta, alexandria, firstClass)).toBe(10);
    expect(await availability(banha, sidiGaber, firstClass)).toBe(9);
    expect(await availability(cairo, alexandria, firstClass)).toBe(9);
  });

  it('counts a seat free again once its hold expired', async () => {
    // Counts may use now(); the index predicate may not (spec §6.3).
    await occupy(seat44, segmentOf(0, 5), 'held', inThePast);

    expect(await availability(cairo, alexandria, firstClass)).toBe(10);
  });

  it('keeps a sold seat taken regardless of time', async () => {
    await occupy(seat44, segmentOf(0, 5), 'sold');

    expect(await availability(cairo, alexandria, firstClass)).toBe(9);
  });

  it('counts a released occupation as free', async () => {
    const occupationId = await occupy(seat44, segmentOf(0, 5), 'sold');
    await releaseSeat(source, occupationId);

    expect(await availability(cairo, alexandria, firstClass)).toBe(10);
  });

  it('returns zero for a class with no coaches on this train', async () => {
    // The JOIN yields no row; the service fills it in.
    expect(await availability(cairo, alexandria, classWithNoCoaches)).toBe(0);
  });

  it('counts a two-stop trip', async () => {
    // Review Focus 3: a single-segment trip, [0,1), must not be an off-by-one.
    const payload = twoStopPayload();
    const plan = seatPlanFrom({ ...payload, tripId: randomUUID() });
    await apply(plan);
    const [firstStation, secondStation] = plan.stops.map((stop) => stop.stationId);
    const travelClassId = plan.coaches[0].travelClassId;

    expect(
      await availabilityOn(plan.tripId, firstStation, secondStation, travelClassId),
    ).toBe(10);
  });

  it('refuses a station the trip does not stop at, naming it', async () => {
    await expect(availability(cairo, aswan, firstClass)).rejects.toThrow(SeatUnknownStationError);
    await expect(availability(cairo, aswan, firstClass)).rejects.toThrow(
      new RegExp(aswan),
    );
  });

  it('refuses a destination before its origin, naming both', async () => {
    await expect(availability(alexandria, cairo, firstClass)).rejects.toThrow(
      SeatSegmentOrderError,
    );
    await expect(availability(alexandria, cairo, firstClass)).rejects.toThrow(
      new RegExp(`${cairo}`),
    );
  });

  it('refuses the same station as origin and destination', async () => {
    await expect(availability(cairo, cairo, firstClass)).rejects.toThrow(SeatSegmentOrderError);
  });

  it('counts an overnight DST-crossing trip exactly as a same-day one', async () => {
    // Review Focus 5: overlap is stop order, never the clock. The payload below
    // crosses midnight and a DST boundary; results must match the same-day fixture.
    const overnightPayload = tripPayload({
      stops: sixStopPayload().stops.map((stop, index) => ({
        ...stop,
        arrivalAt: index === 0 ? null : `2026-03-${28 + Math.floor(index / 4)}T0${index % 4}:30:00+02:00`,
        departureAt:
          index === 5
            ? null
            : `2026-03-${28 + Math.floor(index / 4)}T0${index % 4}:35:00+02:00`,
      })),
    });
    const overnightPlan = seatPlanFrom(overnightPayload);
    await apply(overnightPlan);
    const [s0, , s2, , , s5] = overnightPlan.stops.map((stop) => stop.stationId);
    const overnightSeat = overnightPlan.seats.find(
      (seat) => seat.travelClassId === overnightPlan.coaches[0].travelClassId,
    )!.id;

    await occupySeat(source, overnightSeat, overnightPlan.tripId, segmentOf(0, 2), 'sold');

    expect(
      await availabilityOn(overnightPlan.tripId, s0, s2, overnightPlan.coaches[0].travelClassId),
    ).toBe(9);
    expect(
      await availabilityOn(overnightPlan.tripId, s2, s5, overnightPlan.coaches[0].travelClassId),
    ).toBe(10);
  });

  it('does not issue more queries for twenty trips than for one', async () => {
    async function queriesFor(count: number): Promise<AvailabilityQuery[]> {
      const queries: AvailabilityQuery[] = [];
      for (let i = 0; i < count; i += 1) {
        const plan = seatPlanFrom({ ...sixStopPayload(), tripId: randomUUID() });
        await apply(plan);
        queries.push({
          tripId: plan.tripId,
          originStationId: plan.stops[0].stationId,
          destinationStationId: plan.stops[plan.stops.length - 1].stationId,
          travelClassId: plan.coaches[0].travelClassId,
        });
      }
      return queries;
    }

    const onePage = await queriesFor(1);
    const one = await countStatements(source, () => service.availabilityFor(onePage));

    const twentyPage = await queriesFor(19);
    const twenty = await countStatements(source, () =>
      service.availabilityFor([...onePage, ...twentyPage]),
    );

    expect(one.queries).toHaveLength(2);
    expect(twenty.queries).toHaveLength(one.queries.length);
  });
});
