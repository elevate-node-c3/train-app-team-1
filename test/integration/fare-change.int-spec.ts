import { randomUUID } from 'node:crypto';
import type { DataSource } from 'typeorm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { ErrorCode, EVENT_TYPES } from '@app/contracts';

import { DataSourceInitializer } from '../../libs/common/src/persistence/data-source-initializer.js';
import { TypeOrmUnitOfWork } from '../../libs/common/src/persistence/typeorm-unit-of-work.js';
import { TypeOrmOutboxRepository } from '../../libs/messaging/src/outbox/typeorm-outbox.repository.js';

import { FareChangeRepository } from '../../apps/catalog/src/modules/operations/fare-change.repository.js';
import {
  FareChangeService,
  type ChangeFareRequest,
} from '../../apps/catalog/src/modules/operations/fare-change.service.js';
import { OperationsAuditRepository } from '../../apps/catalog/src/modules/operations/operations-audit.repository.js';
import { OperationsAuditService } from '../../apps/catalog/src/modules/operations/operations-audit.service.js';
import { OperationsRequestRepository } from '../../apps/catalog/src/modules/operations/operations-request.repository.js';

import {
  catalogDataSource,
  CATALOG_TABLES,
  closeCatalogDataSource,
} from './support/catalog-database.js';

/**
 * Changing a fare, against real Postgres.
 *
 * The property this file exists for is the one no double can prove: the new
 * fare row, the audit entry, the `FareChanged` outbox event and the
 * idempotency key commit **together or not at all**. `entityManagerOf` only
 * accepts a context the real `TypeOrmUnitOfWork` minted, so an in-memory
 * stand-in could not exercise this path at all (same reasoning as
 * `timetable-publish.int-spec.ts`).
 */

const OPERATOR = '33333333-3333-4333-8333-333333333333';

const IDS = {
  governorate: '10000000-0000-4000-8000-000000000001',
  city: '10000000-0000-4000-8000-000000000002',
  cairo: '20000000-0000-4000-8000-000000000001',
  giza: '20000000-0000-4000-8000-000000000002',
  alexandria: '20000000-0000-4000-8000-000000000003',
  trainType: '30000000-0000-4000-8000-000000000001',
  train: '30000000-0000-4000-8000-000000000002',
  travelClass: '40000000-0000-4000-8000-000000000001',
  timetable: '50000000-0000-4000-8000-000000000001',
  // F4: a second train whose only published version starts in the future.
  futureTrain: '30000000-0000-4000-8000-000000000003',
  futureTimetable: '50000000-0000-4000-8000-000000000002',
} as const;

const TRAIN_NUMBER = '916';
const FUTURE_TRAIN_NUMBER = '917';
const FUTURE_ROUTE_EFFECTIVE_FROM = '2099-01-01';

/**
 * Hides a stored key from the *first* `find`, which is the concurrent-change
 * race: the replay check runs before the winner commits, so the loser only
 * learns about the key when its own `record` hits the primary key -- inside
 * the transaction, after the fare row, the audit entry and the outbox event
 * have all already been written. Same device as
 * `timetable-publish.int-spec.ts`'s `RacingRequestRepository`.
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

describe('changing a fare', () => {
  let source: DataSource;
  let service: FareChangeService;
  let requests: RacingRequestRepository;

  beforeAll(async () => {
    source = await catalogDataSource();
  });

  beforeEach(async () => {
    await source.query(
      `TRUNCATE TABLE ${CATALOG_TABLES.join(', ')}, operations_audit, operations_request, outbox_event CASCADE`,
    );
    await seedCatalogue(source);

    const initializer = new DataSourceInitializer(source);
    const unitOfWork = new TypeOrmUnitOfWork(initializer);
    const outbox = new TypeOrmOutboxRepository(initializer);
    const cls = { isActive: () => false } as never;

    requests = new RacingRequestRepository(source);

    service = new FareChangeService(
      new FareChangeRepository(source),
      new OperationsAuditService(new OperationsAuditRepository(source)),
      requests,
      unitOfWork,
      outbox,
      cls,
    );
  });

  afterAll(async () => {
    await closeCatalogDataSource();
  });

  function request(overrides: Partial<ChangeFareRequest> = {}): ChangeFareRequest {
    return {
      trainNumber: TRAIN_NUMBER,
      travelClassId: IDS.travelClass,
      originStationId: IDS.cairo,
      destinationStationId: IDS.alexandria,
      amountPiastres: 20_000,
      effectiveFrom: new Date(Date.now() + 60_000).toISOString(),
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

  describe('a fare change that commits', () => {
    it('writes the fare, its audit entry, its event and its key', async () => {
      const result = await service.changeFare(request(), 'commit-key', OPERATOR);

      expect(result).toMatchObject({
        previousAmountPiastres: null,
        newAmountPiastres: 20_000,
      });

      expect(await countOf('fare')).toBe(1);
      expect(await countOf('operations_audit')).toBe(1);
      expect(await countOf('operations_request')).toBe(1);
      expect(await outboxTypes()).toContain(EVENT_TYPES.fareChanged);

      const [entry] = (await source.query(
        'SELECT * FROM operations_audit',
      )) as Record<string, unknown>[];
      expect(entry).toMatchObject({
        action: 'fare.changed',
        actor_account_id: OPERATOR,
        train_id: IDS.train,
        before: null,
        tickets_affected: 0,
      });
    });

    it('keeps the previous fare row in the history (CAT-2, BR-30)', async () => {
      await service.changeFare(request({ amountPiastres: 15_000 }), 'first', OPERATOR);
      await service.changeFare(
        request({
          amountPiastres: 20_000,
          effectiveFrom: new Date(Date.now() + 120_000).toISOString(),
        }),
        'second',
        OPERATOR,
      );

      expect(await countOf('fare')).toBe(2);
    });
  });

  /**
   * The file's reason for existing. A fare change whose transaction rejects
   * must leave no fare row, no audit entry, no outbox event and no
   * idempotency key -- and the only way to show that is to make a write
   * inside the real transaction fail after the others have already run.
   */
  describe('a fare change that rolls back', () => {
    it('leaves no fare row, no audit entry, no outbox event and no key', async () => {
      // `actor_account_id` is a uuid column, so a malformed actor fails the
      // audit insert -- after the fare row has already been written in the
      // same transaction.
      await expect(
        service.changeFare(request(), 'bad-actor-key', 'not-a-uuid'),
      ).rejects.toThrow();

      expect(await countOf('fare')).toBe(0);
      expect(await countOf('operations_audit')).toBe(0);
      expect(await countOf('operations_request')).toBe(0);
      expect(await outboxTypes()).toEqual([]);
    });

    it('leaves nothing behind when a concurrent change already committed the key', async () => {
      // A key already committed by a concurrent change, hidden from this
      // attempt's replay check. Its `record` is the last write in the
      // transaction, so the fare row, the audit entry and the outbox event
      // have all been written by the time it fails.
      await source.query(
        `INSERT INTO operations_request (idempotency_key, fingerprint, response_json)
           VALUES ($1, $2, $3::jsonb)`,
        ['raced-key', 'some-other-fingerprint', JSON.stringify('{}')],
      );
      requests.hideNextFind('raced-key');

      const rejection = await service
        .changeFare(request(), 'raced-key', OPERATOR)
        .then(
          () => null,
          (error: unknown) => error,
        );

      // A different fingerprint, so the loser is refused rather than replayed.
      expect(rejection).toMatchObject({ code: ErrorCode.CONFLICT });
      expect(await countOf('fare')).toBe(0);
      expect(await countOf('operations_audit')).toBe(0);
      expect(await outboxTypes()).toEqual([]);
      // The pre-existing key is untouched -- nothing overwrote it.
      const [stored] = (await source.query(
        'SELECT fingerprint FROM operations_request',
      )) as { fingerprint: string }[];
      expect(stored.fingerprint).toBe('some-other-fingerprint');
      expect(await countOf('operations_request')).toBe(1);
    });
  });

  describe('a replayed fare change', () => {
    it('answers from the stored response without writing a second fare', async () => {
      // Same request object, not two calls to `request()`: `effectiveFrom`
      // defaults to `Date.now() + 60s`, so two independent calls would
      // fingerprint differently and the second would be a genuine conflict
      // rather than a replay.
      const req = request();
      const first = await service.changeFare(req, 'replay-key', OPERATOR);
      const second = await service.changeFare(req, 'replay-key', OPERATOR);

      expect(second).toEqual(first);
      expect(await countOf('fare')).toBe(1);
      expect(await countOf('operations_audit')).toBe(1);
    });
  });

  describe('references and ordering, against the real route', () => {
    it('refuses a pair the train does not run in order', async () => {
      const rejection = await service
        .changeFare(
          request({ originStationId: IDS.alexandria, destinationStationId: IDS.cairo }),
          'order-key',
          OPERATOR,
        )
        .then(
          () => null,
          (error: unknown) => error,
        );

      expect(rejection).toMatchObject({ code: ErrorCode.VALIDATION_ERROR });
      expect(await countOf('fare')).toBe(0);
    });

    it('refuses an amount that would price a segment below one it contains (CAT-2)', async () => {
      // Cairo -> Giza is already 12,000; Cairo -> Alexandria for less than
      // that undercuts a segment it contains.
      await service.changeFare(
        request({ originStationId: IDS.cairo, destinationStationId: IDS.giza, amountPiastres: 12_000 }),
        'inner-key',
        OPERATOR,
      );

      const rejection = await service
        .changeFare(
          request({ originStationId: IDS.cairo, destinationStationId: IDS.alexandria, amountPiastres: 10_000 }),
          'outer-key',
          OPERATOR,
        )
        .then(
          () => null,
          (error: unknown) => error,
        );

      expect(rejection).toMatchObject({
        code: ErrorCode.VALIDATION_ERROR,
        details: [expect.objectContaining({ field: 'amountPiastres' })],
      });
      // Only the inner fare was written; the outer refusal wrote nothing.
      expect(await countOf('fare')).toBe(1);
    });

    // F4: the route must be checked against the fare's own `effectiveFrom`
    // civil date, not today's -- an operator who publishes next month's
    // timetable must still be able to correct its fares before it goes live.
    it('accepts a fare change for a train whose only published version starts in the future', async () => {
      const result = await service.changeFare(
        request({
          trainNumber: FUTURE_TRAIN_NUMBER,
          effectiveFrom: new Date(`${FUTURE_ROUTE_EFFECTIVE_FROM}T00:00:00.000Z`).toISOString(),
        }),
        'future-route-key',
        OPERATOR,
      );

      expect(result).toMatchObject({ newAmountPiastres: 20_000 });
      expect(await countOf('fare')).toBe(1);
    });
  });

  // F1/F2/F3: the lock must hold only the `fare` rows of the exact tuple --
  // serialising a genuine collision on the same (class, pair), but never
  // blocking anything else on the same train.
  describe('the lock two concurrent changes take', () => {
    it('serialises two changes to the same class and pair', async () => {
      await service.changeFare(
        request({ amountPiastres: 15_000, effectiveFrom: new Date(Date.now() + 10_000).toISOString() }),
        'seed-key',
        OPERATOR,
      );

      const [resultA, resultB] = await Promise.all([
        service.changeFare(
          request({ amountPiastres: 20_000, effectiveFrom: new Date(Date.now() + 20_000).toISOString() }),
          'concurrent-a',
          OPERATOR,
        ),
        service.changeFare(
          request({ amountPiastres: 30_000, effectiveFrom: new Date(Date.now() + 30_000).toISOString() }),
          'concurrent-b',
          OPERATOR,
        ),
      ]);

      // All three rows exist: the seed, and both concurrent changes.
      expect(await countOf('fare')).toBe(3);
      expect(await countOf('operations_audit')).toBe(3);

      // Genuine serialisation, not a lucky interleave: whichever of A/B
      // acquired the lock first saw only the seed (15,000) as "previous".
      // The other blocked until the first committed, then saw the
      // *first's* new amount as its own "previous" -- only possible if its
      // `lockFareHistory` query ran, and was answered, strictly after the
      // other's commit.
      const winner = resultA.previousAmountPiastres === 15_000 ? resultA : resultB;
      const loser = winner === resultA ? resultB : resultA;

      expect(winner.previousAmountPiastres).toBe(15_000);
      expect(loser.previousAmountPiastres).toBe(winner.newAmountPiastres);
    });

    it('lets two changes on different pairs of the same train proceed without blocking', async () => {
      const [resultA, resultB] = await Promise.all([
        service.changeFare(
          request({ originStationId: IDS.cairo, destinationStationId: IDS.giza, amountPiastres: 12_000 }),
          'pair-a',
          OPERATOR,
        ),
        service.changeFare(
          request({ originStationId: IDS.giza, destinationStationId: IDS.alexandria, amountPiastres: 7_000 }),
          'pair-b',
          OPERATOR,
        ),
      ]);

      expect(resultA.newAmountPiastres).toBe(12_000);
      expect(resultB.newAmountPiastres).toBe(7_000);
      expect(await countOf('fare')).toBe(2);
      expect(await countOf('operations_audit')).toBe(2);
    });
  });

  describe('a reused instant, not a reused key (F5)', () => {
    it('refuses a same-instant resubmission under a new key as a conflict, not a 500', async () => {
      const effectiveFrom = new Date(Date.now() + 60_000).toISOString();

      await service.changeFare(request({ amountPiastres: 20_000, effectiveFrom }), 'first-key', OPERATOR);

      const rejection = await service
        .changeFare(request({ amountPiastres: 21_000, effectiveFrom }), 'second-key', OPERATOR)
        .then(
          () => null,
          (error: unknown) => error,
        );

      expect(rejection).toMatchObject({
        code: ErrorCode.CONFLICT,
        details: [expect.objectContaining({ field: 'effectiveFrom' })],
      });
      expect(await countOf('fare')).toBe(1);
    });
  });
});

/** The smallest catalogue a fare change can be made against, with a
 * published route so the order and containment rules have something real to
 * check. */
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
    [IDS.alexandria, 'Alexandria', 'الإسكندرية'],
  ] as const) {
    await source.query(
      `INSERT INTO station (id, city_id, name_ar, name_en) VALUES ($1, $2, $3, $4)`,
      [id, IDS.city, nameAr, nameEn],
    );
  }

  await source.query(
    `INSERT INTO train_type (id, name_en, name_ar) VALUES ($1, 'VIP', 'في اي بي')`,
    [IDS.trainType],
  );
  await source.query(
    `INSERT INTO train (id, train_number, train_type_id) VALUES ($1, $2, $3)`,
    [IDS.train, Number(TRAIN_NUMBER), IDS.trainType],
  );
  await source.query(
    `INSERT INTO travel_class (id, name_en, name_ar) VALUES ($1, 'First Class AC', 'الدرجة الأولى المكيفة')`,
    [IDS.travelClass],
  );

  // A published route, effective well before today, so the order and
  // containment checks have a real travel order to read.
  await source.query(
    `INSERT INTO timetable (id, train_id, running_days, effective_from, version, status)
       VALUES ($1, $2, ARRAY[0,1,2,3,4,5,6]::smallint[], '2026-01-01', 1, 'published')`,
    [IDS.timetable, IDS.train],
  );

  const stops = [
    [IDS.cairo, 1, null, '08:00'],
    [IDS.giza, 2, '08:30', '08:40'],
    [IDS.alexandria, 3, '10:00', null],
  ] as const;

  for (const [stationId, position, arrival, departure] of stops) {
    await source.query(
      `INSERT INTO timetable_stop (id, timetable_id, station_id, position, day_offset, arrival_time, departure_time)
         VALUES ($1, $2, $3, $4, 0, $5, $6)`,
      [randomUUID(), IDS.timetable, stationId, position, arrival, departure],
    );
  }

  // F4: a second train whose *only* published version starts well in the
  // future -- the case "probe with today" refused outright.
  await source.query(
    `INSERT INTO train (id, train_number, train_type_id) VALUES ($1, $2, $3)`,
    [IDS.futureTrain, Number(FUTURE_TRAIN_NUMBER), IDS.trainType],
  );
  await source.query(
    `INSERT INTO timetable (id, train_id, running_days, effective_from, version, status)
       VALUES ($1, $2, ARRAY[0,1,2,3,4,5,6]::smallint[], $3, 1, 'published')`,
    [IDS.futureTimetable, IDS.futureTrain, FUTURE_ROUTE_EFFECTIVE_FROM],
  );

  for (const [stationId, position, arrival, departure] of stops) {
    await source.query(
      `INSERT INTO timetable_stop (id, timetable_id, station_id, position, day_offset, arrival_time, departure_time)
         VALUES ($1, $2, $3, $4, 0, $5, $6)`,
      [randomUUID(), IDS.futureTimetable, stationId, position, arrival, departure],
    );
  }
}
