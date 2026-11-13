import { randomUUID } from 'node:crypto';
import type { DataSource } from 'typeorm';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { DataSourceInitializer } from '../../libs/common/src/persistence/data-source-initializer.js';
import { TypeOrmUnitOfWork } from '../../libs/common/src/persistence/typeorm-unit-of-work.js';

import { segmentOf, stationsInUse } from '../../apps/inventory/src/modules/seats/segment.js';
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
import { SeatUsageRepository } from '../../apps/inventory/src/modules/seats/seat-usage.repository.js';

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
const seat45 = SIX_STOP_TRIP.seatIds[1];
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
let usageRepository: SeatUsageRepository;

beforeEach(async () => {
  source = await inventoryDataSource();
  await truncateInventory(source);
  await seedSixStopTrip(source);

  planRepository = new SeatPlanRepository();
  unitOfWork = new TypeOrmUnitOfWork(new DataSourceInitializer(source));
  repository = new AvailabilityRepository(source);
  service = new AvailabilityService(repository);
  usageRepository = new SeatUsageRepository(source);
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

  it('counts a trip with no stop timestamps exactly as the ordinary same-day fixture', async () => {
    // Review Focus 5: overlap is stop order, never the clock. trip_stop has no
    // timestamp column at all, and plannedStopsFrom orders stops by the
    // payload's own `position` field — never by arrival/departure, and never
    // by the order stops happen to arrive in the array. This payload removes
    // both potential clock stand-ins at once: every arrivalAt/departureAt is
    // null, and the stops array itself is shuffled while each stop keeps its
    // true `position`. If order were ever derived from the array index or
    // from a tied/absent timestamp instead of `position`, Ramsis would not
    // sort before Alexandria and the assertions below could not both hold.
    const base = sixStopPayload();
    const shuffledIndexes = [3, 0, 5, 1, 4, 2];
    const overnightPayload = {
      ...base,
      tripId: randomUUID(),
      stops: shuffledIndexes.map((index) => ({
        ...base.stops[index],
        arrivalAt: null,
        departureAt: null,
      })),
    };
    const overnightPlan = seatPlanFrom(overnightPayload);
    await apply(overnightPlan);

    // Ground truth, independent of whatever order the plan actually produced:
    // base.stops[i] is Ramsis, Banha, Tanta, ... by construction (sixStopPayload's
    // comment). Reading s0/s2/s5 back from overnightPlan.stops instead would make
    // this test pass no matter how badly the plan mis-ordered its stops, because
    // the occupied segment and the query would drift together.
    const s0 = base.stops[0].stationId;
    const s2 = base.stops[2].stationId;
    const s5 = base.stops[5].stationId;
    const travelClassId = overnightPlan.coaches[0].travelClassId;
    const overnightSeat = overnightPlan.seats.find(
      (seat) => seat.travelClassId === travelClassId,
    )!.id;

    await occupySeat(source, overnightSeat, overnightPlan.tripId, segmentOf(0, 2), 'sold');
    // The identical scenario on the ordinary same-day fixture, for direct comparison.
    await occupy(seat44, segmentOf(0, 2), 'sold');

    const occupiedOnOvernight = await availabilityOn(overnightPlan.tripId, s0, s2, travelClassId);
    const freeOnOvernight = await availabilityOn(overnightPlan.tripId, s2, s5, travelClassId);

    expect(occupiedOnOvernight).toBe(await availability(ramsis, tanta, firstClass));
    expect(freeOnOvernight).toBe(await availability(tanta, alexandria, firstClass));
    expect(occupiedOnOvernight).toBe(9);
    expect(freeOnOvernight).toBe(10);
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

describe('seat usage for catalog', () => {
  async function usageFor(tripIds: string[]) {
    return usageRepository.usageFor(tripIds);
  }

  it('counts held and sold separately', async () => {
    await occupy(seat44, segmentOf(0, 2), 'held', inAnHour);
    await occupy(seat45, segmentOf(1, 3), 'sold');

    expect(await usageFor([tripId])).toEqual([
      expect.objectContaining({ tripId, heldCount: 1, soldCount: 1 }),
    ]);
  });

  it('reports both ends of a segment as in use', async () => {
    // Ramsis 0 -> Tanta 2 puts Ramsis, Banha and Tanta in use.
    await occupy(seat44, segmentOf(0, 2), 'sold');

    const [usage] = await usageFor([tripId]);

    expect(usage.stationIdsInUse.slice().sort()).toEqual(
      [ramsis, banha, tanta].slice().sort(),
    );
  });

  it('ignores released and expired-held occupations', async () => {
    const soldId = await occupy(seat44, segmentOf(0, 2), 'sold');
    await releaseSeat(source, soldId);
    await occupy(seat45, segmentOf(0, 2), 'held', inThePast);

    expect(await usageFor([tripId])).toEqual([
      { tripId, soldCount: 0, heldCount: 0, stationIdsInUse: [] },
    ]);
  });

  it('returns a zero row for a trip with no usage', async () => {
    expect(await usageFor([tripId])).toEqual([
      { tripId, soldCount: 0, heldCount: 0, stationIdsInUse: [] },
    ]);
  });

  it('returns a zero row for a trip inventory has never seen', async () => {
    // Catalog must get an answer, not silence.
    const unseenTripId = randomUUID();

    const result = await usageFor([unseenTripId]);

    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({
      tripId: unseenTripId,
      soldCount: 0,
      heldCount: 0,
      stationIdsInUse: [],
    });
  });

  it('does not issue more queries for twenty trips than for one', async () => {
    async function tripIdsFor(count: number): Promise<string[]> {
      const ids: string[] = [];
      for (let i = 0; i < count; i += 1) {
        const plan = seatPlanFrom({ ...sixStopPayload(), tripId: randomUUID() });
        await apply(plan);
        ids.push(plan.tripId);
      }
      return ids;
    }

    const oneId = await tripIdsFor(1);
    const one = await countStatements(source, () => usageFor(oneId));

    const twentyMore = await tripIdsFor(19);
    const twenty = await countStatements(source, () => usageFor([...oneId, ...twentyMore]));

    expect(one.queries).toHaveLength(1);
    expect(twenty.queries).toHaveLength(one.queries.length);
  });

  it('does not double a count when the same trip id is requested twice', async () => {
    await occupy(seat44, segmentOf(0, 2), 'sold');

    const result = await usageFor([tripId, tripId]);

    expect(result).toHaveLength(1);
    expect(result[0]).toEqual(
      expect.objectContaining({ tripId, soldCount: 1, heldCount: 0 }),
    );
  });

  it('agrees with stationsInUse on which stations an occupied segment touches', async () => {
    const segment = segmentOf(1, 3);
    await occupy(seat44, segment, 'sold');

    // Derived from the same source stationsInUse reads, not hardcoded, so this
    // test fails if the SQL's inclusive-both-ends rule ever drifts from it.
    const expectedStationIds = stationsInUse(segment).map(
      (position) => SIX_STOP_TRIP.stationIds[position],
    );

    const [usage] = await usageFor([tripId]);

    expect(usage.stationIdsInUse.slice().sort()).toEqual(expectedStationIds.slice().sort());
  });
});
