import { randomUUID } from 'node:crypto';
import type { DataSource } from 'typeorm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  addCivilDays,
  cairoToday,
  ErrorCode,
  EVENT_TYPES,
  type PublishTimetableRequest,
} from '@app/contracts';

import { DataSourceInitializer } from '../../libs/common/src/persistence/data-source-initializer.js';
import { TypeOrmUnitOfWork } from '../../libs/common/src/persistence/typeorm-unit-of-work.js';
import { TypeOrmOutboxRepository } from '../../libs/messaging/src/outbox/typeorm-outbox.repository.js';

import { OperationsAuditRepository } from '../../apps/catalog/src/modules/operations/operations-audit.repository.js';
import { OperationsAuditService } from '../../apps/catalog/src/modules/operations/operations-audit.service.js';
import { OperationsRequestRepository } from '../../apps/catalog/src/modules/operations/operations-request.repository.js';
import { TimetablePublishRepository } from '../../apps/catalog/src/modules/operations/timetable-publish.repository.js';
import { TimetablePublishService } from '../../apps/catalog/src/modules/operations/timetable-publish.service.js';
import { TimetableVersionService } from '../../apps/catalog/src/modules/operations/timetable-version.service.js';
import { TimetableEntity } from '../../apps/catalog/src/modules/timetables/entities/timetable.entity.js';
import { TimetableStopEntity } from '../../apps/catalog/src/modules/timetables/entities/timetable-stop.entity.js';
import { TimetablesService } from '../../apps/catalog/src/modules/timetables/timetables.service.js';
import { TrainCoachEntity } from '../../apps/catalog/src/modules/trains/entities/train-coach.entity.js';
import { FareEntity } from '../../apps/catalog/src/modules/fares/entities/fare.entity.js';
import { DatedTripEntity } from '../../apps/catalog/src/modules/trips/entities/dated-trip.entity.js';
import { TripsService } from '../../apps/catalog/src/modules/trips/trips.service.js';

import {
  catalogDataSource,
  CATALOG_TABLES,
  closeCatalogDataSource,
} from './support/catalog-database.js';

/**
 * Version, stops, fares, audit, outbox and idempotency key must commit together.
 * entityManagerOf requires a real TypeOrmUnitOfWork context; all collaborators
 * honor that transaction. Real TripsService inserts dated trips in Compose's
 * Postgres; only inventory's gRPC response is stubbed.
 */

const OPERATOR = '33333333-3333-4333-8333-333333333333';

const IDS = {
  governorate: '10000000-0000-4000-8000-000000000001',
  city: '10000000-0000-4000-8000-000000000002',
  cairo: '20000000-0000-4000-8000-000000000001',
  giza: '20000000-0000-4000-8000-000000000002',
  beniSuef: '20000000-0000-4000-8000-000000000003',
  trainType: '30000000-0000-4000-8000-000000000001',
  train: '30000000-0000-4000-8000-000000000002',
  travelClass: '40000000-0000-4000-8000-000000000001',
  secondClass: '40000000-0000-4000-8000-000000000002',
  coachLayout: '50000000-0000-4000-8000-000000000001',
  trainCoach: '60000000-0000-4000-8000-000000000001',
} as const;

const TRAIN_NUMBER = '911';

/**
 * Hide the key on the first find to model a replay check before a concurrent
 * commit. The final record then hits the real primary key after the other
 * writes, exercising rollback.
 */
class RacingRequestRepository extends OperationsRequestRepository {
  private hidden: string | null = null;

  hideNextFind(idempotencyKey: string): void {
    this.hidden = idempotencyKey;
  }

  override async find(
    idempotencyKey: string,
  ): ReturnType<OperationsRequestRepository['find']> {
    if (this.hidden === idempotencyKey) {
      this.hidden = null;
      return null;
    }
    return super.find(idempotencyKey);
  }
}

describe('publishing a timetable version', () => {
  let source: DataSource;
  let service: TimetablePublishService;
  /** Separate seeding publish path. */
  let timetables: TimetablesService;
  let requests: RacingRequestRepository;
  /** Current Cairo civil date for relative fixture dates. */
  let today: string;
  let effectiveFrom: string;

  beforeAll(async () => {
    source = await catalogDataSource();

    const initializer = new DataSourceInitializer(source);
    const unitOfWork = new TypeOrmUnitOfWork(initializer);
    const outbox = new TypeOrmOutboxRepository(initializer);
    const cls = { isActive: () => false } as never;

    const trips = new TripsService(
      source.getRepository(TimetableEntity),
      source.getRepository(TimetableStopEntity),
      source.getRepository(TrainCoachEntity),
      source.getRepository(FareEntity),
      unitOfWork,
      outbox,
      source.getRepository(DatedTripEntity),
      cls,
    );

    requests = new RacingRequestRepository(source);

    // Stub inventory with no sold or held seats.
    const seatUsage = {
      seatUsageForTrips: async (tripIds: string[]) =>
        new Map(
          tripIds.map((tripId) => [
            tripId,
            { tripId, soldCount: 0, heldCount: 0, stationIdsInUse: [] },
          ]),
        ),
    } as never;

    service = new TimetablePublishService(
      new TimetablePublishRepository(source),
      new TimetableVersionService(source.getRepository(TimetableEntity)),
      new OperationsAuditService(new OperationsAuditRepository(source)),
      requests,
      seatUsage,
      trips,
      unitOfWork,
      outbox,
      cls,
    );

    timetables = new TimetablesService(
      source.getRepository(TimetableEntity),
      unitOfWork,
      outbox,
      trips,
      cls,
    );
  });

  beforeEach(async () => {
    // TRUNCATE bypasses the append-only audit trigger that rejects DELETE.
    await source.query(
      `TRUNCATE TABLE ${CATALOG_TABLES.join(', ')}, operations_audit, operations_request, outbox_event CASCADE`,
    );
    await seedCatalogue(source);

    today = cairoToday(new Date());
    effectiveFrom = addCivilDays(today, 2);
  });

  afterAll(async () => {
    await closeCatalogDataSource();
  });

  /** One weekday only, so the booking window holds four or five dates. */
  function request(
    overrides: Partial<PublishTimetableRequest> = {},
  ): PublishTimetableRequest {
    const weekday = new Date(`${effectiveFrom}T00:00:00.000Z`).getUTCDay();

    return {
      trainNumber: TRAIN_NUMBER,
      runningDays: [weekday],
      effectiveFrom,
      stops: [
        {
          stationId: IDS.cairo,
          position: 1,
          dayOffset: 0,
          arrivalTime: null,
          departureTime: '08:00',
        },
        {
          stationId: IDS.giza,
          position: 2,
          dayOffset: 0,
          arrivalTime: '08:30',
          departureTime: '08:40',
        },
        {
          stationId: IDS.beniSuef,
          position: 3,
          dayOffset: 0,
          arrivalTime: '10:00',
          departureTime: null,
        },
      ],
      coaches: [
        {
          position: 1,
          coachNumber: 1,
          travelClassId: IDS.travelClass,
          coachLayoutId: IDS.coachLayout,
        },
      ],
      fares: [
        {
          travelClassId: IDS.travelClass,
          originStationId: IDS.cairo,
          destinationStationId: IDS.giza,
          amountPiastres: 5000,
        },
        {
          travelClassId: IDS.travelClass,
          originStationId: IDS.cairo,
          destinationStationId: IDS.beniSuef,
          amountPiastres: 10000,
        },
        {
          travelClassId: IDS.travelClass,
          originStationId: IDS.giza,
          destinationStationId: IDS.beniSuef,
          amountPiastres: 7000,
        },
      ],
      ...overrides,
    };
  }

  const countOf = async (table: string): Promise<number> => {
    const [{ count }] = (await source.query(
      `SELECT count(*)::int AS count FROM "${table}"`,
    )) as { count: number }[];
    return count;
  };

  const outboxTypes = async (): Promise<string[]> => {
    const rows = (await source.query(
      'SELECT event_type FROM outbox_event ORDER BY occurred_at, id',
    )) as { event_type: string }[];
    return rows.map((row) => row.event_type);
  };

  describe('a publish that commits', () => {
    it('writes the version, its stops, its fares, its audit entry, its event and its key', async () => {
      const result = await service.publish(request(), 'commit-key', OPERATOR);

      expect(result).toMatchObject({ version: 1, changed: 0, withdrawn: 0 });
      expect(result.created).toBeGreaterThan(0);

      const [version] = (await source.query(
        'SELECT * FROM timetable WHERE id = $1',
        [result.timetableId],
      )) as Record<string, unknown>[];
      expect(version).toMatchObject({
        train_id: IDS.train,
        version: 1,
        status: 'published',
        effective_until: null,
      });

      expect(await countOf('timetable_stop')).toBe(3);
      expect(await countOf('fare')).toBe(3);
      expect(await countOf('operations_audit')).toBe(1);
      expect(await countOf('operations_request')).toBe(1);
      expect(await outboxTypes()).toContain(EVENT_TYPES.timetablePublished);

      // Reported creation counts must match actual rows.
      expect(await countOf('dated_trip')).toBe(result.created);
      expect(await outboxTypes()).toContain(EVENT_TYPES.tripPublished);

      const [entry] = (await source.query(
        'SELECT * FROM operations_audit',
      )) as Record<string, unknown>[];
      expect(entry).toMatchObject({
        action: 'timetable.published',
        actor_account_id: OPERATOR,
        train_id: IDS.train,
        before: null,
        tickets_affected: 0,
      });
    });

    it('bounds the predecessor and re-points its trips, keeping their ids', async () => {
      const first = await service.publish(request(), 'v1-key', OPERATOR);
      const tripsBefore = (await source.query(
        'SELECT id, service_date, timetable_version FROM dated_trip ORDER BY service_date',
      )) as { id: string; service_date: Date; timetable_version: number }[];
      expect(tripsBefore.length).toBeGreaterThan(0);

      const later = addCivilDays(effectiveFrom, 7);
      const second = await service.publish(
        request({ effectiveFrom: later }),
        'v2-key',
        OPERATOR,
      );

      expect(second.version).toBe(2);
      expect(second.changed).toBeGreaterThan(0);

      const [predecessor] = (await source.query(
        "SELECT to_char(effective_until, 'YYYY-MM-DD') AS until FROM timetable WHERE id = $1",
        [first.timetableId],
      )) as { until: string }[];
      expect(predecessor.until).toBe(addCivilDays(later, -1));

      // Reuse trip IDs when moving them to version 2; do not withdraw them.
      const tripsAfter = (await source.query(
        'SELECT id, timetable_version FROM dated_trip WHERE service_date >= $1',
        [later],
      )) as { id: string; timetable_version: number }[];
      expect(tripsAfter.length).toBe(second.changed);
      for (const trip of tripsAfter) {
        expect(tripsBefore.some((before) => before.id === trip.id)).toBe(true);
        expect(trip.timetable_version).toBe(2);
      }
      expect(await outboxTypes()).not.toContain(EVENT_TYPES.tripWithdrawn);
    });

    // Same-day predecessors trigger Postgres exclusion error 23P01.
    // Map it to a conflict without leaving partial writes.
    it('turns the exclusion constraint into a conflict, not a 500', async () => {
      await service.publish(request(), 'same-day-1', OPERATOR);

      const rejection = await service
        .publish(request(), 'same-day-2', OPERATOR)
        .then(
          () => null,
          (error: unknown) => error,
        );

      expect(rejection).toMatchObject({
        code: ErrorCode.CONFLICT,
        details: [expect.objectContaining({ field: 'effectiveFrom' })],
      });
      expect(rejection).toMatchObject({
        details: [
          expect.objectContaining({
            issueKey: 'ISSUE_TIMETABLE_OVERLAPS_OPEN_ENDED_VERSION',
            actionKey: 'ACTION_PICK_NON_OVERLAPPING_DATES',
            params: { version: '1', effectiveFrom },
          }),
        ],
      });

      expect(await countOf('timetable')).toBe(1);
      expect(await countOf('operations_audit')).toBe(1);
      expect(await countOf('operations_request')).toBe(1);
    });
  });

  /**
   * validateFareRules uses submitted coach classes, but createDatedTrip uses
   * train_coach rows. Generation can swallow a mismatch error and leave a
   * published version with no dated trips; reject mismatches before writing.
   */
  describe('the submitted composition', () => {
    it('refuses a mismatch before writing anything', async () => {
      // A second coach the request will not mention, in a class with no fares.
      await source.query(
        `INSERT INTO travel_class (id, name_en, name_ar) VALUES ($1, 'Second', 'ثانية')`,
        [IDS.secondClass],
      );
      await source.query(
        `INSERT INTO train_coach (id, train_id, position, coach_number, travel_class_id, coach_layout_id)
           VALUES ($1, $2, 2, 2, $3, $4)`,
        [randomUUID(), IDS.train, IDS.secondClass, IDS.coachLayout],
      );

      const rejection = await service
        .publish(request(), 'mismatch-key', OPERATOR)
        .then(
          () => null,
          (error: unknown) => error,
        );

      expect(rejection).toMatchObject({
        code: ErrorCode.VALIDATION_ERROR,
        details: expect.arrayContaining([
          expect.objectContaining({ field: 'coaches' }),
        ]),
      });

      expect(await countOf('timetable')).toBe(0);
      expect(await countOf('timetable_stop')).toBe(0);
      expect(await countOf('fare')).toBe(0);
      expect(await countOf('operations_audit')).toBe(0);
      expect(await countOf('operations_request')).toBe(0);
      expect(await outboxTypes()).toEqual([]);
      expect(await countOf('dated_trip')).toBe(0);
    });

    it('publishes, and really generates, when the composition matches', async () => {
      const result = await service.publish(request(), 'match-key', OPERATOR);

      expect(result.created).toBeGreaterThan(0);
      expect(await countOf('dated_trip')).toBe(result.created);
    });
  });

  /**
   * uq_dated_trip_train_date reserves (train, service_date) even when withdrawn.
   * createDatedTrip also looks up trips without a status filter; reuse that row.
   */
  describe('a date whose trip was withdrawn', () => {
    it('is resurrected on republish, keeping its trip id, and announced again', async () => {
      const everyDay = [0, 1, 2, 3, 4, 5, 6];
      const weekday = new Date(`${effectiveFrom}T00:00:00.000Z`).getUTCDay();
      const withoutThatDay = everyDay.filter((day) => day !== weekday);

      await service.publish(
        request({ runningDays: everyDay }),
        'daily-key',
        OPERATOR,
      );
      const dropped = await service.publish(
        request({
          runningDays: withoutThatDay,
          effectiveFrom: addCivilDays(effectiveFrom, 1),
        }),
        'drop-key',
        OPERATOR,
      );
      expect(dropped.withdrawn).toBeGreaterThan(0);

      const withdrawnRows = (await source.query(
        `SELECT id, to_char(service_date, 'YYYY-MM-DD') AS service_date
           FROM dated_trip WHERE status = 'withdrawn' ORDER BY service_date`,
      )) as { id: string; service_date: string }[];
      expect(withdrawnRows.length).toBe(dropped.withdrawn);

      const publishedBefore = (await outboxTypes()).filter(
        (type) => type === EVENT_TYPES.tripPublished,
      ).length;

      const restored = await service.publish(
        request({
          runningDays: everyDay,
          effectiveFrom: addCivilDays(effectiveFrom, 2),
        }),
        'restore-key',
        OPERATOR,
      );

      // Resurrected trips count as changed, not created, because their IDs already exist.
      expect(restored.created).toBe(0);
      expect(restored.changed).toBeGreaterThan(0);

      for (const row of withdrawnRows) {
        const [after] = (await source.query(
          'SELECT id, status, timetable_version FROM dated_trip WHERE id = $1',
          [row.id],
        )) as { id: string; status: string; timetable_version: number }[];
        expect(after.status).toBe('published');
        expect(after.timetable_version).toBe(restored.version);
      }

      const [{ count }] = (await source.query(
        `SELECT count(*)::int AS count FROM dated_trip
           WHERE service_date = ANY($1::date[])`,
        [withdrawnRows.map((row) => row.service_date)],
      )) as { count: number }[];
      expect(count).toBe(withdrawnRows.length);

      // Republish events let inventory recreate seats for resurrected trips.
      const publishedAfter = (await outboxTypes()).filter(
        (type) => type === EVENT_TYPES.tripPublished,
      ).length;
      expect(publishedAfter - publishedBefore).toBe(restored.changed);
    });
  });

  describe('a publish that rolls back', () => {
    it('leaves no version row, no audit entry, no outbox event and no key', async () => {
      // Hide a concurrently committed key from the replay check. Its record is
      // the last write, so the constraint failure must roll back version, stops,
      // fares, audit and outbox writes.
      await source.query(
        `INSERT INTO operations_request (idempotency_key, fingerprint, response_json)
           VALUES ($1, $2, $3::jsonb)`,
        ['raced-key', 'some-other-fingerprint', JSON.stringify('{}')],
      );
      requests.hideNextFind('raced-key');

      const rejection = await service
        .publish(request(), 'raced-key', OPERATOR)
        .then(
          () => null,
          (error: unknown) => error,
        );

      // A different fingerprint, so the loser is refused rather than replayed.
      expect(rejection).toMatchObject({ code: ErrorCode.CONFLICT });

      expect(await countOf('timetable')).toBe(0);
      expect(await countOf('timetable_stop')).toBe(0);
      expect(await countOf('fare')).toBe(0);
      expect(await countOf('operations_audit')).toBe(0);
      expect(await outboxTypes()).toEqual([]);
      // Keep the winner's key and fingerprint.
      const [stored] = (await source.query(
        'SELECT fingerprint FROM operations_request',
      )) as { fingerprint: string }[];
      expect(stored.fingerprint).toBe('some-other-fingerprint');
      expect(await countOf('operations_request')).toBe(1);
      // A failed commit must not start trip generation.
      expect(await countOf('dated_trip')).toBe(0);
    });

    it('leaves nothing behind when the audit insert itself fails', async () => {
      // A malformed actor fails the UUID audit column after the version, stops
      // and fares have been written.
      await expect(
        service.publish(request(), 'bad-actor-key', 'not-a-uuid'),
      ).rejects.toThrow();

      expect(await countOf('timetable')).toBe(0);
      expect(await countOf('timetable_stop')).toBe(0);
      expect(await countOf('fare')).toBe(0);
      expect(await countOf('operations_audit')).toBe(0);
      expect(await countOf('operations_request')).toBe(0);
      expect(await outboxTypes()).toEqual([]);
    });
  });

  describe('a replayed publish', () => {
    it('answers from the stored response without writing a second version', async () => {
      const first = await service.publish(request(), 'replay-key', OPERATOR);
      const outboxAfterFirst = (await outboxTypes()).length;

      const second = await service.publish(request(), 'replay-key', OPERATOR);

      expect(second).toEqual(first);
      expect(await countOf('timetable')).toBe(1);
      expect(await countOf('operations_audit')).toBe(1);
      expect((await outboxTypes()).length).toBe(outboxAfterFirst);
    });
  });

  /** Seed and operator publishes must share the database's no-overlap constraint. */
  describe('the seeding publish path, after versioning', () => {
    it('still publishes the seeded timetable, to exactly one published row', async () => {
      const timetableId = randomUUID();
      await seedDraftTimetable(source, timetableId, today);

      const published = await timetables.publishTimetable(timetableId);

      expect(published.status).toBe('published');
      expect(await publishedRowsOfTrain()).toBe(1);
      expect(await outboxTypes()).toContain(EVENT_TYPES.timetablePublished);
      // Seeding has no actor to record in a BR-52 audit entry.
      expect(await countOf('operations_audit')).toBe(0);
    });

    it('refuses a second overlapping published row, whichever path writes it', async () => {
      const result = await service.publish(request(), 'seed-key', OPERATOR);

      expect(result.version).toBe(1);
      expect(await publishedRowsOfTrain()).toBe(1);

      await expect(
        source.query(
          `INSERT INTO timetable (id, train_id, running_days, effective_from, version, status)
             VALUES ($1, $2, ARRAY[1]::smallint[], $3, 99, 'published')`,
          [randomUUID(), IDS.train, effectiveFrom],
        ),
      ).rejects.toThrow(/excl_timetable_published_overlap/);
    });
  });

  const publishedRowsOfTrain = async (): Promise<number> => {
    const [{ count }] = (await source.query(
      `SELECT count(*)::int AS count FROM timetable
         WHERE train_id = $1 AND status = 'published'`,
      [IDS.train],
    )) as { count: number }[];
    return count;
  };
});

/**
 * Match catalog.seed.ts: a draft, its stops and fares already exist;
 * publishing only changes status.
 */
async function seedDraftTimetable(
  source: DataSource,
  timetableId: string,
  effectiveFrom: string,
): Promise<void> {
  await source.query(
    `INSERT INTO timetable (id, train_id, running_days, effective_from, version, status)
       VALUES ($1, $2, ARRAY[0,1,2,3,4,5,6]::smallint[], $3, 1, 'draft')`,
    [timetableId, IDS.train, effectiveFrom],
  );

  const stops = [
    [IDS.cairo, 1, null, '08:00'],
    [IDS.giza, 2, '08:30', '08:40'],
    [IDS.beniSuef, 3, '10:00', null],
  ] as const;

  for (const [stationId, position, arrival, departure] of stops) {
    await source.query(
      `INSERT INTO timetable_stop (id, timetable_id, station_id, position, day_offset, arrival_time, departure_time)
         VALUES ($1, $2, $3, $4, 0, $5, $6)`,
      [randomUUID(), timetableId, stationId, position, arrival, departure],
    );
  }

  // Make the fare effective before the first running day's departure.
  const fareFrom = new Date(Date.now() - 86_400_000);

  for (const [origin, destination, amount] of [
    [IDS.cairo, IDS.giza, 5000],
    [IDS.cairo, IDS.beniSuef, 10000],
    [IDS.giza, IDS.beniSuef, 7000],
  ] as const) {
    await source.query(
      `INSERT INTO fare (id, train_id, travel_class_id, origin_station_id, destination_station_id, amount_piastres, effective_from)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        randomUUID(),
        IDS.train,
        IDS.travelClass,
        origin,
        destination,
        amount,
        fareFrom,
      ],
    );
  }
}

/** Minimal catalog fixture for publishing. */
async function seedCatalogue(source: DataSource): Promise<void> {
  await source.query(
    `INSERT INTO governorate (id, name_ar, name_en, sort_order) VALUES ($1, 'القاهرة', 'Cairo', 1)`,
    [IDS.governorate],
  );
  await source.query(
    `INSERT INTO city (id, governorate_id, name_ar, name_en) VALUES ($1, $2, 'القاهرة', 'Cairo')`,
    [IDS.city, IDS.governorate],
  );

  for (const [id, nameEn, nameAr] of [
    [IDS.cairo, 'Cairo', 'القاهرة'],
    [IDS.giza, 'Giza', 'الجيزة'],
    [IDS.beniSuef, 'Beni Suef', 'بني سويف'],
  ] as const) {
    await source.query(
      `INSERT INTO station (id, city_id, name_ar, name_en) VALUES ($1, $2, $3, $4)`,
      [id, IDS.city, nameAr, nameEn],
    );
  }

  await source.query(
    `INSERT INTO train_type (id, name_en, name_ar) VALUES ($1, 'Express', 'سريع')`,
    [IDS.trainType],
  );
  await source.query(
    `INSERT INTO train (id, train_number, train_type_id) VALUES ($1, $2, $3)`,
    [IDS.train, Number(TRAIN_NUMBER), IDS.trainType],
  );
  await source.query(
    `INSERT INTO travel_class (id, name_en, name_ar) VALUES ($1, 'First', 'أولى')`,
    [IDS.travelClass],
  );
  await source.query(
    `INSERT INTO coach_layout (id, layout_name, rows) VALUES ($1, 'first-2x2', $2::jsonb)`,
    [
      IDS.coachLayout,
      JSON.stringify([
        { rowNumber: 1, leftSeats: ['1A', '1B'], rightSeats: ['1C', '1D'] },
      ]),
    ],
  );
  await source.query(
    `INSERT INTO train_coach (id, train_id, position, coach_number, travel_class_id, coach_layout_id)
       VALUES ($1, $2, 1, 1, $3, $4)`,
    [IDS.trainCoach, IDS.train, IDS.travelClass, IDS.coachLayout],
  );
}
