import { randomUUID } from 'node:crypto';
import { vi } from 'vitest';

import {
  cairoInstantOf,
  type EventEnvelope,
  type PublishTimetableRequest,
  type TripSeatUsage,
} from '@app/contracts';
import type { TransactionContext } from '../../libs/common/src/persistence/unit-of-work.port.js';

import type { CoachLayoutEntity } from '../../apps/catalog/src/modules/trains/entities/coach-layout.entity.js';
import type { TrainCoachEntity } from '../../apps/catalog/src/modules/trains/entities/train-coach.entity.js';
import type { TrainEntity } from '../../apps/catalog/src/modules/trains/entities/train.entity.js';
import type { TravelClassEntity } from '../../apps/catalog/src/modules/trains/entities/travel-class.entity.js';
import type { TimetableEntity } from '../../apps/catalog/src/modules/timetables/entities/timetable.entity.js';
import type { TimetableStopEntity } from '../../apps/catalog/src/modules/timetables/entities/timetable-stop.entity.js';
import type { DatedTripEntity } from '../../apps/catalog/src/modules/trips/entities/dated-trip.entity.js';
import type { TripStopEntity } from '../../apps/catalog/src/modules/trips/entities/trip-stop.entity.js';
import type { OperationsAuditEntity } from '../../apps/catalog/src/modules/operations/entities/operations-audit.entity.js';
import type { StoredOperationsRequest } from '../../apps/catalog/src/modules/operations/operations-request.types.js';
import { OperationsAuditService } from '../../apps/catalog/src/modules/operations/operations-audit.service.js';
import { TimetablePublishService } from '../../apps/catalog/src/modules/operations/timetable-publish.service.js';
import { TripsService } from '../../apps/catalog/src/modules/trips/trips.service.js';
import {
  buildTripPublished,
  buildTripWithdrawn,
} from '../../apps/catalog/src/modules/trips/trip-events.factory.js';
import {
  fareKey,
  resolveStopTimes,
  type FareIndex,
} from '../../apps/catalog/src/modules/trips/trip-generation.types.js';

/**
 * The doubles `TimetablePublishService`'s two unit specs share.
 *
 * It lives here rather than in either spec because importing one spec from
 * another would register its `describe`s twice, and copying the doubles would
 * let the two files' idea of "what the database does" drift apart.
 *
 * The honesty rule it follows: writes staged inside `withTransaction` become
 * visible only when the callback resolves, and a rejection discards the stage
 * without ever merging it -- the same guarantee a Postgres `ROLLBACK` gives.
 * That is enough to prove *this service's* contract with its collaborators.
 * It is deliberately **not** offered as proof of the transactional property
 * itself: `test/integration/timetable-publish.int-spec.ts` proves that
 * against real Postgres through the real `TypeOrmUnitOfWork`, because an
 * in-memory double proves nothing about the production path.
 */

/** Cairo civil 'today' for every spec that uses this harness. */
export const TODAY = '2026-06-20';
/** The last date the booking window plus generation's margin reaches. */
export const WINDOW_END = '2026-07-20';
/** When a republish in these specs takes effect. */
export const EFFECTIVE_FROM = '2026-06-22';

export const TRAIN_ID = '11111111-1111-4111-8111-111111111111';
export const TRAIN_NUMBER = '900';
export const TRAIN_TYPE_ID = '11111111-1111-4111-8111-11111111aaaa';
export const OPERATOR = '33333333-3333-4333-8333-333333333333';

export const CAIRO = 'aaaaaaaa-0000-4000-8000-000000000001';
export const GIZA = 'aaaaaaaa-0000-4000-8000-000000000002';
export const BENI_SUEF = 'aaaaaaaa-0000-4000-8000-000000000003';
export const ASYUT = 'aaaaaaaa-0000-4000-8000-000000000004';

export const FIRST_CLASS = 'bbbbbbbb-0000-4000-8000-000000000001';
export const LAYOUT = 'cccccccc-0000-4000-8000-000000000001';

const KNOWN_STATIONS = [CAIRO, GIZA, BENI_SUEF, ASYUT];

const TRAIN: TrainEntity = {
  id: TRAIN_ID,
  trainNumber: Number(TRAIN_NUMBER),
  trainType: { id: TRAIN_TYPE_ID, nameEn: 'Express', nameAr: 'سريع' },
} as TrainEntity;

const TRAVEL_CLASS: TravelClassEntity = {
  id: FIRST_CLASS,
  nameEn: 'First',
  nameAr: 'أولى',
};

const COACH_LAYOUT: CoachLayoutEntity = {
  id: LAYOUT,
  layoutName: 'first-2x2',
  rows: [
    { rowNumber: 1, leftSeats: ['1A', '1B'], rightSeats: ['1C', '1D'] },
    { rowNumber: 2, leftSeats: ['2A', '2B'], rightSeats: ['2C', '2D'] },
  ],
};

const TRAIN_COACHES: TrainCoachEntity[] = [
  {
    id: 'dddddddd-0000-4000-8000-000000000001',
    train: TRAIN,
    position: 1,
    coachNumber: 1,
    travelClass: TRAVEL_CLASS,
    coachLayout: COACH_LAYOUT,
  } as TrainCoachEntity,
];

/** Every in-order pair of the four-station route, cheapest-containment safe. */
const FARE_AMOUNTS: Record<string, number> = {
  [`${CAIRO}|${GIZA}`]: 5000,
  [`${CAIRO}|${BENI_SUEF}`]: 10000,
  [`${CAIRO}|${ASYUT}`]: 15000,
  [`${GIZA}|${BENI_SUEF}`]: 7000,
  [`${GIZA}|${ASYUT}`]: 12000,
  [`${BENI_SUEF}|${ASYUT}`]: 6000,
};

function faresFor(
  stationIds: string[],
): PublishTimetableRequest['fares'] {
  const fares: PublishTimetableRequest['fares'] = [];

  for (let i = 0; i < stationIds.length - 1; i += 1) {
    for (let j = i + 1; j < stationIds.length; j += 1) {
      fares.push({
        travelClassId: FIRST_CLASS,
        originStationId: stationIds[i],
        destinationStationId: stationIds[j],
        amountPiastres: FARE_AMOUNTS[`${stationIds[i]}|${stationIds[j]}`],
      });
    }
  }

  return fares;
}

const THREE_STOP_TIMES: [string | null, string | null][] = [
  [null, '08:00'],
  ['08:30', '08:40'],
  ['10:00', null],
];

const FOUR_STOP_TIMES: [string | null, string | null][] = [
  [null, '08:00'],
  ['08:30', '08:40'],
  ['10:00', '10:10'],
  ['12:00', null],
];

function stopsFor(
  stationIds: string[],
  times: [string | null, string | null][],
): PublishTimetableRequest['stops'] {
  return stationIds.map((stationId, index) => ({
    stationId,
    position: index + 1,
    dayOffset: 0,
    arrivalTime: times[index][0],
    departureTime: times[index][1],
  }));
}

const EVERY_DAY = [0, 1, 2, 3, 4, 5, 6];

/** The three-station route, running every day, effective in two days. */
export function validRequest(
  overrides: Partial<PublishTimetableRequest> = {},
): PublishTimetableRequest {
  const stations = [CAIRO, GIZA, BENI_SUEF];

  return {
    trainNumber: TRAIN_NUMBER,
    runningDays: EVERY_DAY,
    effectiveFrom: EFFECTIVE_FROM,
    stops: stopsFor(stations, THREE_STOP_TIMES),
    coaches: [
      {
        position: 1,
        coachNumber: 1,
        travelClassId: FIRST_CLASS,
        coachLayoutId: LAYOUT,
      },
    ],
    fares: faresFor(stations),
    ...overrides,
  };
}

/** The same route with Asyut added: every existing trip's shape moves. */
export function republishWithExtraStop(): PublishTimetableRequest {
  const stations = [CAIRO, GIZA, BENI_SUEF, ASYUT];

  return validRequest({
    stops: stopsFor(stations, FOUR_STOP_TIMES),
    fares: faresFor(stations),
  });
}

/** The same route, no longer running on Fridays. */
export function republishWithoutFridays(): PublishTimetableRequest {
  return validRequest({ runningDays: [0, 1, 2, 3, 4, 6] });
}

/** The same route, ten minutes later throughout. */
export function republishTenMinutesLater(): PublishTimetableRequest {
  const stations = [CAIRO, GIZA, BENI_SUEF];

  return validRequest({
    stops: stopsFor(stations, [
      [null, '08:10'],
      ['08:40', '08:50'],
      ['10:10', null],
    ]),
  });
}

/** A different body under the same key: one fare corrected. */
export function otherRequest(): PublishTimetableRequest {
  const request = validRequest();

  return {
    ...request,
    fares: request.fares.map((fare, index) =>
      index === 0 ? { ...fare, amountPiastres: 5500 } : fare,
    ),
  };
}

/**
 * Three independent faults at once: a first stop carrying an arrival time, a
 * station repeated, and a station id the catalogue does not have. All three
 * must be named in one answer.
 */
export function requestWithThreeProblems(): PublishTimetableRequest {
  const unknown = 'aaaaaaaa-0000-4000-8000-0000000000ff';

  return validRequest({
    stops: [
      {
        stationId: CAIRO,
        position: 1,
        dayOffset: 0,
        arrivalTime: '07:50',
        departureTime: '08:00',
      },
      {
        stationId: CAIRO,
        position: 2,
        dayOffset: 0,
        arrivalTime: '08:30',
        departureTime: '08:40',
      },
      {
        stationId: unknown,
        position: 3,
        dayOffset: 0,
        arrivalTime: '10:00',
        departureTime: null,
      },
    ],
  });
}

interface StagingContext extends TransactionContext {
  staging: (() => void)[];
}

interface Store {
  timetables: TimetableEntity[];
  timetableStops: TimetableStopEntity[];
  fares: { key: string; amountPiastres: number; effectiveFrom: Date }[];
  trips: DatedTripEntity[];
  tripStops: TripStopEntity[];
  audit: OperationsAuditEntity[];
  requests: StoredOperationsRequest[];
  events: EventEnvelope[];
}

function emptyStore(): Store {
  return {
    timetables: [],
    timetableStops: [],
    fares: [],
    trips: [],
    tripStops: [],
    audit: [],
    requests: [],
    events: [],
  };
}

export interface PublishHarness {
  service: TimetablePublishService;
  store: Store;
  /** How many `withTransaction` calls the whole publish opened. */
  transactions: () => number;
  timetableCount: () => Promise<number>;
  outboxCount: () => Promise<number>;
  auditCount: () => Promise<number>;
  publishedEventTypes: () => string[];
  tripOn: (serviceDate: string) => Promise<DatedTripEntity>;
  stopStationIdsOn: (serviceDate: string) => Promise<string[]>;
  /** Programs inventory's answer for one trip id. */
  answerSeatUsage: (tripId: string, usage: Omit<TripSeatUsage, 'tripId'>) => void;
  /** Makes every seat-usage lookup fail with the given error. */
  rejectSeatUsage: (error: Error) => void;
  /** Trip ids the seam was asked about, in call order. */
  seatUsageAsks: () => string[][];
  /**
   * Runs `work` the first time a transaction commits -- the window in which
   * the generation timer can insert the new version's trips.
   */
  afterFirstCommit: (work: () => void) => void;
  /**
   * What `TripsService`'s timer does on its own: inserts dated trips for the
   * newest published version across a date range.
   */
  simulateGeneration: (fromDate: string, toDate: string) => void;
  /**
   * Makes the *next* `find` of this key answer null while the row is really
   * there -- the concurrent-publish race, where the replay check runs before
   * the winner commits and the duplicate only surfaces from `record`.
   */
  hideNextFind: (idempotencyKey: string) => void;
  /**
   * Makes the next version insert fail with `error`, so the raw Postgres
   * codes a legitimate publish can earn -- `23P01` from the exclusion
   * constraint, `23505` from a version collision -- can be told apart.
   */
  failNextInsertWith: (error: Error) => void;
}

export interface HarnessOptions {
  /**
   * Seeds a published version 1 of the three-station route plus a dated trip
   * for every date in the window, which is what a republish acts on.
   */
  withExistingVersion?: boolean;
}

/**
 * One wired `TimetablePublishService` over an in-memory store.
 *
 * The pure parts of `TripsService` -- `buildTripStops`,
 * `buildCompositionSnapshot`, `calculateCapacity` -- are the **real** ones,
 * constructed the way `trip-generation-versions.spec.ts` does, so a stop
 * resolved by the publish and a stop resolved by generation cannot disagree
 * here while agreeing in production.
 */
export function makeHarness(options: HarnessOptions = {}): PublishHarness {
  const store = emptyStore();
  let transactionCount = 0;
  let firstCommitHook: (() => void) | null = null;
  let seatUsageError: Error | null = null;
  const hiddenKeys = new Set<string>();
  const seatUsageAnswers = new Map<string, TripSeatUsage>();
  const asks: string[][] = [];

  const stage = (ctx: TransactionContext, work: () => void): void => {
    (ctx as StagingContext).staging.push(work);
  };

  const unitOfWork = {
    withTransaction: vi.fn(
      async <T>(work: (ctx: TransactionContext) => Promise<T>): Promise<T> => {
        transactionCount += 1;
        const ctx: StagingContext = { driver: 'harness', staging: [] };
        const result = await work(ctx);
        // Only reached if `work` resolved: a throw skips this entirely, so
        // nothing staged during a rejected transaction becomes visible.
        for (const apply of ctx.staging) apply();
        const hook = firstCommitHook;
        firstCommitHook = null;
        hook?.();
        return result;
      },
    ),
  };

  const outbox = {
    append: vi.fn(async (ctx: TransactionContext, envelope: EventEnvelope) => {
      stage(ctx, () => store.events.push(envelope));
    }),
  };

  const auditService = new OperationsAuditService({
    append: async (ctx: TransactionContext, entity: OperationsAuditEntity) => {
      stage(ctx, () => store.audit.push(entity));
      return entity;
    },
    list: async () => ({ entries: [], nextCursor: null }),
  } as never);

  const requests = {
    find: vi.fn(async (idempotencyKey: string) => {
      if (hiddenKeys.has(idempotencyKey)) {
        hiddenKeys.delete(idempotencyKey);
        return null;
      }

      return (
        store.requests.find(
          (request) => request.idempotencyKey === idempotencyKey,
        ) ?? null
      );
    }),
    record: vi.fn(
      async (ctx: TransactionContext, request: StoredOperationsRequest) => {
        // insert, not save: a key already present is a unique violation, the
        // same way the real primary key behaves.
        if (
          store.requests.some(
            (stored) => stored.idempotencyKey === request.idempotencyKey,
          )
        ) {
          throw Object.assign(new Error('duplicate key value'), {
            code: '23505',
          });
        }
        stage(ctx, () => store.requests.push(request));
      },
    ),
  };

  const seatUsage = {
    seatUsageForTrips: vi.fn(async (tripIds: string[]) => {
      asks.push([...tripIds]);
      if (seatUsageError) throw seatUsageError;

      return new Map(
        tripIds.map((tripId) => [
          tripId,
          seatUsageAnswers.get(tripId) ?? {
            tripId,
            soldCount: 0,
            heldCount: 0,
            stationIdsInUse: [],
          },
        ]),
      );
    }),
  };

  const versions = {
    latestVersionNumber: vi.fn(
      async () =>
        store.timetables.reduce(
          (highest, timetable) => Math.max(highest, timetable.version),
          0,
        ),
    ),
    supersede: vi.fn(
      async (ctx: TransactionContext, _trainId: string, from: string) => {
        const lastDay = addDays(from, -1);
        const outgoing = store.timetables.filter(
          (timetable) =>
            timetable.status === 'published' &&
            timetable.effectiveFrom < from &&
            (!timetable.effectiveUntil || timetable.effectiveUntil >= from),
        );
        stage(ctx, () => {
          for (const timetable of outgoing) {
            timetable.effectiveUntil = lastDay;
          }
        });
      },
    ),
  };

  const insertFailures: Error[] = [];
  const repository = makeRepository(store, stage, insertFailures);
  const trips = makeTripsService(store);

  const service = new TimetablePublishService(
    repository as never,
    versions as never,
    auditService,
    requests as never,
    seatUsage as never,
    trips,
    unitOfWork as never,
    outbox as never,
    { isActive: () => false } as never,
  );

  if (options.withExistingVersion) {
    seedExistingVersion(store, trips);
  }

  return {
    service,
    store,
    transactions: () => transactionCount,
    timetableCount: async () => store.timetables.length,
    outboxCount: async () => store.events.length,
    auditCount: async () => store.audit.length,
    publishedEventTypes: () => store.events.map((event) => event.type),
    tripOn: async (serviceDate: string) => {
      const trip = store.trips.find((row) => row.serviceDate === serviceDate);
      if (!trip) throw new Error(`No trip on ${serviceDate}`);
      return trip;
    },
    stopStationIdsOn: async (serviceDate: string) => {
      const trip = store.trips.find((row) => row.serviceDate === serviceDate);
      if (!trip) throw new Error(`No trip on ${serviceDate}`);
      return store.tripStops
        .filter((stop) => stop.trip.id === trip.id)
        .sort((left, right) => left.position - right.position)
        .map((stop) => stop.stationId);
    },
    answerSeatUsage: (tripId, usage) => {
      seatUsageAnswers.set(tripId, { tripId, ...usage });
    },
    rejectSeatUsage: (error) => {
      seatUsageError = error;
    },
    seatUsageAsks: () => asks,
    afterFirstCommit: (work) => {
      firstCommitHook = work;
    },
    simulateGeneration: (fromDate, toDate) => {
      const newest = [...store.timetables]
        .filter((timetable) => timetable.status === 'published')
        .sort((left, right) => right.version - left.version)[0];
      if (!newest) return;

      for (
        let serviceDate = fromDate;
        serviceDate <= toDate;
        serviceDate = addDays(serviceDate, 1)
      ) {
        if (store.trips.some((trip) => trip.serviceDate === serviceDate)) {
          continue;
        }
        insertTrip(store, newest, serviceDate, trips);
      }
    },
    hideNextFind: (idempotencyKey) => {
      hiddenKeys.add(idempotencyKey);
    },
    failNextInsertWith: (error) => {
      insertFailures.push(error);
    },
  };
}

/** Civil-date arithmetic, duplicated here so the harness needs no clock. */
function addDays(civilDate: string, days: number): string {
  const date = new Date(`${civilDate}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function makeRepository(
  store: Store,
  stage: (ctx: TransactionContext, work: () => void) => void,
  insertFailures: Error[],
) {
  return {
    // The real one unwraps the context; here the reads below ignore the
    // manager entirely, because the store has only one state.
    managerOf: vi.fn(() => undefined),

    resolveReferences: vi.fn(
      async (params: {
        trainNumber: number | null;
        stationIds: string[];
        coachLayoutIds: string[];
        travelClassIds: string[];
      }) => ({
        train: params.trainNumber === TRAIN.trainNumber ? TRAIN : null,
        knownStationIds: new Set(
          params.stationIds.filter((id) => KNOWN_STATIONS.includes(id)),
        ),
        knownCoachLayoutIds: new Set(
          params.coachLayoutIds.filter((id) => id === LAYOUT),
        ),
        knownTravelClassIds: new Set(
          params.travelClassIds.filter((id) => id === FIRST_CLASS),
        ),
        layoutsById: new Map(
          params.coachLayoutIds.includes(LAYOUT)
            ? [[LAYOUT, COACH_LAYOUT]]
            : [],
        ),
        classesById: new Map(
          params.travelClassIds.includes(FIRST_CLASS)
            ? [[FIRST_CLASS, TRAVEL_CLASS]]
            : [],
        ),
      }),
    ),

    publishedVersionsOf: vi.fn(async () =>
      store.timetables.filter((timetable) => timetable.status === 'published'),
    ),

    stopsOf: vi.fn(async (timetableId: string) =>
      store.timetableStops
        .filter((stop) => stop.timetable.id === timetableId)
        .sort((left, right) => left.position - right.position),
    ),

    publishedTripsBetween: vi.fn(
      async (_trainId: string, fromDate: string, toDate: string) =>
        store.trips
          .filter(
            (trip) =>
              trip.status === 'published' &&
              trip.serviceDate >= fromDate &&
              trip.serviceDate <= toDate,
          )
          .sort((left, right) =>
            left.serviceDate.localeCompare(right.serviceDate),
          ),
    ),

    tripStopsOf: vi.fn(async (tripIds: string[]) => {
      const byTrip = new Map<string, TripStopEntity[]>();
      for (const stop of store.tripStops) {
        if (!tripIds.includes(stop.trip.id)) continue;
        const existing = byTrip.get(stop.trip.id);
        if (existing) existing.push(stop);
        else byTrip.set(stop.trip.id, [stop]);
      }
      for (const stops of byTrip.values()) {
        stops.sort((left, right) => left.position - right.position);
      }
      return byTrip;
    }),

    insertVersion: vi.fn(
      async (
        ctx: TransactionContext,
        version: {
          train: TrainEntity;
          runningDays: number[];
          effectiveFrom: string;
          versionNumber: number;
        },
      ) => {
        const failure = insertFailures.shift();
        if (failure) throw failure;

        const row = {
          id: randomUUID(),
          train: version.train,
          runningDays: version.runningDays,
          effectiveFrom: version.effectiveFrom,
          effectiveUntil: null,
          version: version.versionNumber,
          status: 'published',
        } as TimetableEntity;

        stage(ctx, () => store.timetables.push(row));
        return row;
      },
    ),

    insertStops: vi.fn(
      async (
        ctx: TransactionContext,
        timetable: TimetableEntity,
        stops: PublishTimetableRequest['stops'],
      ) => {
        const rows = stops.map(
          (stop) =>
            ({
              id: randomUUID(),
              timetable,
              station: { id: stop.stationId },
              stationId: stop.stationId,
              position: stop.position,
              dayOffset: stop.dayOffset,
              arrivalTime: stop.arrivalTime,
              departureTime: stop.departureTime,
            }) as TimetableStopEntity,
        );

        stage(ctx, () => store.timetableStops.push(...rows));
        return rows;
      },
    ),

    upsertFares: vi.fn(
      async (
        ctx: TransactionContext,
        params: {
          fares: PublishTimetableRequest['fares'];
          effectiveFrom: Date;
        },
      ) => {
        stage(ctx, () => {
          for (const fare of params.fares) {
            const key = fareKey(
              fare.travelClassId,
              fare.originStationId,
              fare.destinationStationId,
            );
            const existing = store.fares.find(
              (row) =>
                row.key === key &&
                row.effectiveFrom.getTime() === params.effectiveFrom.getTime(),
            );
            if (existing) existing.amountPiastres = fare.amountPiastres;
            else
              store.fares.push({
                key,
                amountPiastres: fare.amountPiastres,
                effectiveFrom: params.effectiveFrom,
              });
          }
        });
      },
    ),

    repoint: vi.fn(
      async (
        ctx: TransactionContext,
        params: {
          tripId: string;
          timetable: TimetableEntity;
          compositionSnapshot: DatedTripEntity['compositionSnapshot'];
          publishedAt: Date;
          stops: {
            stationId: string;
            position: number;
            arrivalAt: Date | null;
            departureAt: Date | null;
          }[];
        },
      ) => {
        const trip = store.trips.find((row) => row.id === params.tripId);
        if (!trip) return null;

        stage(ctx, () => {
          trip.timetable = params.timetable;
          trip.timetableVersion = params.timetable.version;
          trip.compositionSnapshot = params.compositionSnapshot;
          trip.status = 'published';
          trip.publishedAt = params.publishedAt;

          store.tripStops = store.tripStops.filter(
            (stop) => stop.trip.id !== params.tripId,
          );
          store.tripStops.push(
            ...params.stops.map(
              (stop) =>
                ({
                  id: randomUUID(),
                  trip,
                  station: { id: stop.stationId },
                  stationId: stop.stationId,
                  position: stop.position,
                  arrivalAt: stop.arrivalAt,
                  departureAt: stop.departureAt,
                }) as TripStopEntity,
            ),
          );
        });

        return trip;
      },
    ),
  };
}

/**
 * A real `TripsService` with its database reads replaced.
 *
 * `createDatedTrip` and `withdrawDatedTrip` commit on their own in
 * production, so they commit straight into the store here --
 * `createDatedTrip` returning an existing trip rather than failing, exactly
 * as the real one does after a unique violation.
 */
function makeTripsService(store: Store): TripsService {
  const trips = new TripsService(
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
  );

  trips.buildFareIndex = async (): Promise<FareIndex> => {
    const index: FareIndex = new Map();
    for (const fare of store.fares) {
      const prices = index.get(fare.key) ?? [];
      prices.push({
        effectiveFrom: fare.effectiveFrom,
        amountPiastres: fare.amountPiastres,
      });
      index.set(fare.key, prices);
    }
    for (const prices of index.values()) {
      prices.sort(
        (left, right) =>
          right.effectiveFrom.getTime() - left.effectiveFrom.getTime(),
      );
    }
    return index;
  };

  trips.getTimetableStops = async (timetableId: string) =>
    store.timetableStops
      .filter((stop) => stop.timetable.id === timetableId)
      .sort((left, right) => left.position - right.position);

  trips.getTrainCoaches = async () => TRAIN_COACHES;

  trips.createDatedTrip = async (timetable, serviceDate) => {
    const existing = store.trips.find(
      (trip) => trip.serviceDate === serviceDate,
    );
    if (existing) return existing;

    const trip = insertTrip(store, timetable, serviceDate, trips);
    store.events.push(
      buildTripPublished({
        eventId: randomUUID(),
        correlationId: randomUUID(),
        occurredAt: new Date(),
        payload: {
          tripId: trip.id,
          trainId: TRAIN_ID,
          trainNumber: TRAIN.trainNumber,
          trainType: TRAIN.trainType,
          serviceDate,
          timetableVersion: timetable.version,
          capacity: trips.calculateCapacity(TRAIN_COACHES),
          stops: [],
          coaches: trip.compositionSnapshot,
        },
      }),
    );
    return trip;
  };

  trips.withdrawDatedTrip = async (tripId: string) => {
    const trip = store.trips.find((row) => row.id === tripId);
    if (!trip) throw new Error(`No trip ${tripId}`);
    trip.status = 'withdrawn';
    store.events.push(
      buildTripWithdrawn({
        eventId: randomUUID(),
        correlationId: randomUUID(),
        occurredAt: new Date(),
        tripId,
      }),
    );
    return trip;
  };

  return trips;
}

function insertTrip(
  store: Store,
  timetable: TimetableEntity,
  serviceDate: string,
  trips: TripsService,
): DatedTripEntity {
  const timetableStops = store.timetableStops
    .filter((stop) => stop.timetable.id === timetable.id)
    .sort((left, right) => left.position - right.position);

  const trip = {
    id: randomUUID(),
    train: TRAIN,
    timetable,
    serviceDate,
    timetableVersion: timetable.version,
    compositionSnapshot: trips.buildCompositionSnapshot(TRAIN_COACHES),
    status: 'published',
    publishedAt: new Date(),
    createdAt: new Date(),
  } as DatedTripEntity;

  store.trips.push(trip);
  store.tripStops.push(
    ...timetableStops.map((stop) => {
      const { arrivalAt, departureAt } = resolveStopTimes(
        serviceDate,
        stop.dayOffset,
        stop.arrivalTime,
        stop.departureTime,
      );
      return {
        id: randomUUID(),
        trip,
        station: { id: stop.stationId },
        stationId: stop.stationId,
        position: stop.position,
        arrivalAt,
        departureAt,
      } as TripStopEntity;
    }),
  );

  return trip;
}

/**
 * Version 1 of the three-station route, live since before the window, with a
 * dated trip for every date in it. This is the state a republish acts on.
 */
function seedExistingVersion(store: Store, trips: TripsService): void {
  const timetable = {
    id: randomUUID(),
    train: TRAIN,
    runningDays: EVERY_DAY,
    effectiveFrom: '2026-06-10',
    effectiveUntil: null,
    version: 1,
    status: 'published',
  } as TimetableEntity;

  store.timetables.push(timetable);

  const request = validRequest();

  store.timetableStops.push(
    ...request.stops.map(
      (stop) =>
        ({
          id: randomUUID(),
          timetable,
          station: { id: stop.stationId },
          stationId: stop.stationId,
          position: stop.position,
          dayOffset: stop.dayOffset,
          arrivalTime: stop.arrivalTime,
          departureTime: stop.departureTime,
        }) as TimetableStopEntity,
    ),
  );

  for (const fare of request.fares) {
    store.fares.push({
      key: fareKey(
        fare.travelClassId,
        fare.originStationId,
        fare.destinationStationId,
      ),
      amountPiastres: fare.amountPiastres,
      effectiveFrom: cairoInstantOf('2026-06-10', '00:00'),
    });
  }

  for (
    let serviceDate = TODAY;
    serviceDate <= WINDOW_END;
    serviceDate = addDays(serviceDate, 1)
  ) {
    insertTrip(store, timetable, serviceDate, trips);
  }
}
