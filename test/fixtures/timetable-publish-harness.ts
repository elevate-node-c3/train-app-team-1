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

// Stage writes until work succeeds; integration specs verify real Postgres rollback.

/** Fixed Cairo civil date for the harness. */
export const TODAY = '2026-06-20';
/** Booking-window end, including the generation margin. */
export const WINDOW_END = '2026-07-20';
/** Republish effective date. */
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
export const SECOND_CLASS = 'bbbbbbbb-0000-4000-8000-000000000002';
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

const SECOND_TRAVEL_CLASS: TravelClassEntity = {
  id: SECOND_CLASS,
  nameEn: 'Second',
  nameAr: 'ثانية',
};

const CLASSES_BY_ID = new Map([
  [FIRST_CLASS, TRAVEL_CLASS],
  [SECOND_CLASS, SECOND_TRAVEL_CLASS],
]);

const COACH_LAYOUT: CoachLayoutEntity = {
  id: LAYOUT,
  layoutName: 'first-2x2',
  rows: [
    { rowNumber: 1, leftSeats: ['1A', '1B'], rightSeats: ['1C', '1D'] },
    { rowNumber: 2, leftSeats: ['2A', '2B'], rightSeats: ['2C', '2D'] },
  ],
};

function coachEntity(
  position: number,
  coachNumber: number,
  travelClass: TravelClassEntity,
): TrainCoachEntity {
  return {
    id: `dddddddd-0000-4000-8000-00000000000${position}`,
    train: TRAIN,
    position,
    coachNumber,
    travelClass,
    coachLayout: COACH_LAYOUT,
  } as TrainCoachEntity;
}

/** Default catalog composition: one coach. */
const ONE_COACH: TrainCoachEntity[] = [coachEntity(1, 1, TRAVEL_CLASS)];

const TWO_COACHES: TrainCoachEntity[] = [
  coachEntity(1, 1, TRAVEL_CLASS),
  coachEntity(2, 2, SECOND_TRAVEL_CLASS),
];

// Reverse positions to check that client array order does not matter.
export function twoCoachesReversed(): PublishTimetableRequest['coaches'] {
  return [...TWO_COACHES]
    .sort((left, right) => right.position - left.position)
    .map((coach) => ({
      position: coach.position,
      coachNumber: coach.coachNumber,
      travelClassId: coach.travelClass.id,
      coachLayoutId: coach.coachLayout.id,
    }));
}

/** Fares cover every ordered station pair without undercutting contained segments. */
const FARE_AMOUNTS: Record<string, number> = {
  [`${CAIRO}|${GIZA}`]: 5000,
  [`${CAIRO}|${BENI_SUEF}`]: 10000,
  [`${CAIRO}|${ASYUT}`]: 15000,
  [`${GIZA}|${BENI_SUEF}`]: 7000,
  [`${GIZA}|${ASYUT}`]: 12000,
  [`${BENI_SUEF}|${ASYUT}`]: 6000,
};

function faresFor(stationIds: string[]): PublishTimetableRequest['fares'] {
  const fares: PublishTimetableRequest['fares'] = [];

  // Include both classes for the two-coach harness; unused fares are ignored.
  for (const travelClassId of [FIRST_CLASS, SECOND_CLASS]) {
    for (let i = 0; i < stationIds.length - 1; i += 1) {
      for (let j = i + 1; j < stationIds.length; j += 1) {
        fares.push({
          travelClassId,
          originStationId: stationIds[i],
          destinationStationId: stationIds[j],
          amountPiastres: FARE_AMOUNTS[`${stationIds[i]}|${stationIds[j]}`],
        });
      }
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

/** Three stations, daily service, effective two days after TODAY. */
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

/** Adding Asyut changes the shape of existing trips. */
export function republishWithExtraStop(): PublishTimetableRequest {
  const stations = [CAIRO, GIZA, BENI_SUEF, ASYUT];

  return validRequest({
    stops: stopsFor(stations, FOUR_STOP_TIMES),
    fares: faresFor(stations),
  });
}

/** Same route without Friday service. */
export function republishWithoutFridays(
  overrides: Partial<PublishTimetableRequest> = {},
): PublishTimetableRequest {
  return validRequest({ runningDays: [0, 1, 2, 3, 4, 6], ...overrides });
}

/** Shift every stop by ten minutes. */
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

/** Change one fare to produce a different body under the same key. */
export function otherRequest(): PublishTimetableRequest {
  const request = validRequest();

  return {
    ...request,
    fares: request.fares.map((fare, index) =>
      index === 0 ? { ...fare, amountPiastres: 5500 } : fare,
    ),
  };
}

// Return all three independent validation errors in one response.
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
  /** Total withTransaction calls for one publish. */
  transactions: () => number;
  timetableCount: () => Promise<number>;
  outboxCount: () => Promise<number>;
  auditCount: () => Promise<number>;
  publishedEventTypes: () => string[];
  tripOn: (serviceDate: string) => Promise<DatedTripEntity>;
  stopStationIdsOn: (serviceDate: string) => Promise<string[]>;
  /** Set inventory's response for one trip. */
  answerSeatUsage: (
    tripId: string,
    usage: Omit<TripSeatUsage, 'tripId'>,
  ) => void;
  /** Fail all inventory lookups with the same error. */
  rejectSeatUsage: (error: Error) => void;
  /** Trip ID batches sent to inventory, in call order. */
  seatUsageAsks: () => string[][];
  /** Runs `work` after the first commit, when the generation timer can race. */
  afterFirstCommit: (work: () => void) => void;
  /** Inserts trips the way `TripsService`'s timer does. */
  simulateGeneration: (fromDate: string, toDate: string) => void;
  /** Return null once for this key to simulate a concurrent publish. */
  hideNextFind: (idempotencyKey: string) => void;
  /** Fail the next version insert to check Postgres error mapping. */
  failNextInsertWith: (error: Error) => void;
}

export interface HarnessOptions {
  /** Seeds published version 1 and a trip for every date in the window. */
  withExistingVersion?: boolean;
  /** Gives the train a second coach, so a one-class request is a mismatch. */
  withTwoCoaches?: boolean;
}

// Use real TripsService generation logic over an in-memory store.
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
        // Apply staged writes only after work succeeds.
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
        // Insert, not save: an existing key is a unique violation.
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
    latestVersionNumber: vi.fn(async () =>
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
  const coaches = options.withTwoCoaches ? TWO_COACHES : ONE_COACH;
  const trips = makeTripsService(store, coaches);

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
    seedExistingVersion(store, trips, coaches);
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
        insertTrip(store, newest, serviceDate, trips, coaches);
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

/** Civil-date arithmetic without a clock dependency. */
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
    // The store has one state, so reads ignore the manager.
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
          params.travelClassIds.filter((id) => CLASSES_BY_ID.has(id)),
        ),
        layoutsById: new Map(
          params.coachLayoutIds.includes(LAYOUT)
            ? [[LAYOUT, COACH_LAYOUT]]
            : [],
        ),
        classesById: new Map(
          [...CLASSES_BY_ID].filter(([id]) =>
            params.travelClassIds.includes(id),
          ),
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

    // No status filter: a withdrawn trip still owns its (train, service_date).
    tripsBetween: vi.fn(
      async (_trainId: string, fromDate: string, toDate: string) =>
        store.trips
          .filter(
            (trip) =>
              trip.serviceDate >= fromDate && trip.serviceDate <= toDate,
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

// Replace TripsService reads; reuse existing trips to match its unique-violation
// recovery.
function makeTripsService(
  store: Store,
  coaches: TrainCoachEntity[],
): TripsService {
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

  trips.getTrainCoaches = async () => coaches;

  trips.createDatedTrip = async (timetable, serviceDate) => {
    const existing = store.trips.find(
      (trip) => trip.serviceDate === serviceDate,
    );
    if (existing) return existing;

    const trip = insertTrip(store, timetable, serviceDate, trips, coaches);
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
          capacity: trips.calculateCapacity(coaches),
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
  coaches: TrainCoachEntity[],
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
    compositionSnapshot: trips.buildCompositionSnapshot(coaches),
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

/** Seeds version 1 and a trip for every date in the window. */
function seedExistingVersion(
  store: Store,
  trips: TripsService,
  coaches: TrainCoachEntity[],
): void {
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
    insertTrip(store, timetable, serviceDate, trips, coaches);
  }
}
