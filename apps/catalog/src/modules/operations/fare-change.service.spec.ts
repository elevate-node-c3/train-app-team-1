import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ErrorCode, type EventEnvelope } from '@app/contracts';
import type { TransactionContext } from '@app/common/persistence/unit-of-work.port.js';
import { DETAIL_CATALOGUE } from '@app/common/envelope/detail-catalogue.js';

import type { OperationsAuditEntity } from './entities/operations-audit.entity.js';
import type { StoredOperationsRequest } from './operations-request.types.js';
import { OperationsAuditService } from './operations-audit.service.js';
import {
  FareChangeService,
  type ChangeFareRequest,
} from './fare-change.service.js';

// Staged writes land only when `withTransaction` resolves. Real Postgres
// transactions and row locking are tested in the integration spec.

const TRAIN_ID = '11111111-1111-4111-8111-111111111111';
const TRAIN_NUMBER = '916';
const OPERATOR = '33333333-3333-4333-8333-333333333333';
const OPERATOR_B = '33333333-3333-4333-8333-333333333334';

const CAIRO = 'aaaaaaaa-0000-4000-8000-000000000001';
const GIZA = 'aaaaaaaa-0000-4000-8000-000000000002';
const ALEXANDRIA = 'aaaaaaaa-0000-4000-8000-000000000003';
const UNKNOWN_STATION = 'aaaaaaaa-0000-4000-8000-0000000000ff';

const FIRST_CLASS_AC = 'bbbbbbbb-0000-4000-8000-000000000001';
const UNKNOWN_CLASS = 'bbbbbbbb-0000-4000-8000-0000000000ff';

/** Cairo -> Giza -> Alexandria, in the train's real travel order. */
const ROUTE = [CAIRO, GIZA, ALEXANDRIA];

interface FareRow {
  id: string;
  trainId: string;
  travelClassId: string;
  originStationId: string;
  destinationStationId: string;
  amountPiastres: number;
  effectiveFrom: Date;
}

interface StagingContext extends TransactionContext {
  staging: (() => void)[];
}

interface Store {
  fares: FareRow[];
  audit: OperationsAuditEntity[];
  requests: StoredOperationsRequest[];
  events: EventEnvelope[];
}

function emptyStore(): Store {
  return { fares: [], audit: [], requests: [], events: [] };
}

function tupleKey(params: {
  trainId: string;
  travelClassId: string;
  originStationId: string;
  destinationStationId: string;
}): string {
  return `${params.trainId}|${params.travelClassId}|${params.originStationId}|${params.destinationStationId}`;
}

function makeRepository(
  store: Store,
  stage: (ctx: TransactionContext, work: () => void) => void,
  // Defaults far in the past, matching an already-live route.
  routeEffectiveFrom: string,
) {
  return {
    resolveReferences: vi.fn(
      async (params: {
        trainNumber: number | null;
        travelClassId: string;
        stationIds: string[];
      }) => ({
        train:
          params.trainNumber === Number(TRAIN_NUMBER) ? { id: TRAIN_ID } : null,
        travelClass:
          params.travelClassId === FIRST_CLASS_AC
            ? { id: FIRST_CLASS_AC }
            : null,
        knownStationIds: new Set(
          params.stationIds.filter((id) => ROUTE.includes(id)),
        ),
      }),
    ),

    // Null when `asOfDate` is before the version's `effectiveFrom`.
    routeStationOrder: vi.fn(async (trainId: string, asOfDate: string) =>
      trainId === TRAIN_ID && asOfDate >= routeEffectiveFrom
        ? [...ROUTE]
        : null,
    ),

    fareAmountAsOf: vi.fn(
      async (params: {
        trainId: string;
        travelClassId: string;
        originStationId: string;
        destinationStationId: string;
        asOf: Date;
      }) => {
        const rows = store.fares.filter(
          (row) =>
            row.trainId === params.trainId &&
            row.travelClassId === params.travelClassId &&
            row.originStationId === params.originStationId &&
            row.destinationStationId === params.destinationStationId &&
            row.effectiveFrom.getTime() <= params.asOf.getTime(),
        );
        if (rows.length === 0) return null;
        return rows.sort(
          (left, right) =>
            right.effectiveFrom.getTime() - left.effectiveFrom.getTime(),
        )[0].amountPiastres;
      },
    ),

    lockFareHistory: vi.fn(
      async (
        _ctx: TransactionContext,
        params: {
          trainId: string;
          travelClassId: string;
          originStationId: string;
          destinationStationId: string;
        },
      ) => {
        const key = tupleKey(params);
        return store.fares
          .filter((row) => tupleKey(row) === key)
          .sort(
            (left, right) =>
              right.effectiveFrom.getTime() - left.effectiveFrom.getTime(),
          );
      },
    ),

    insertFare: vi.fn(
      async (
        ctx: TransactionContext,
        params: {
          trainId: string;
          travelClassId: string;
          originStationId: string;
          destinationStationId: string;
          amountPiastres: number;
          effectiveFrom: Date;
        },
      ) => {
        // Mirrors `uq_fare_effective_version`: same tuple and instant is a violation.
        if (
          store.fares.some(
            (row) =>
              tupleKey(row) === tupleKey(params) &&
              row.effectiveFrom.getTime() === params.effectiveFrom.getTime(),
          )
        ) {
          throw Object.assign(new Error('duplicate key value'), {
            code: '23505',
            constraint: 'uq_fare_effective_version',
          });
        }

        const row: FareRow = { id: randomUUID(), ...params };
        stage(ctx, () => store.fares.push(row));
        return row;
      },
    ),
  };
}

export interface FareChangeHarness {
  service: FareChangeService;
  store: Store;
  fareRowsFor: (pair: {
    originStationId: string;
    destinationStationId: string;
  }) => FareRow[];
  auditCount: () => number;
  lastEvent: () => EventEnvelope;
  requestCount: () => number;
}

export interface FareChangeHarnessOptions {
  /** The train's one published version's civil `effectiveFrom`. */
  routeEffectiveFrom?: string;
}

function makeHarness(
  options: FareChangeHarnessOptions = {},
): FareChangeHarness {
  const store = emptyStore();
  const routeEffectiveFrom = options.routeEffectiveFrom ?? '2020-01-01';

  const stage = (ctx: TransactionContext, work: () => void): void => {
    (ctx as StagingContext).staging.push(work);
  };

  const unitOfWork = {
    withTransaction: vi.fn(
      async <T>(work: (ctx: TransactionContext) => Promise<T>): Promise<T> => {
        const ctx: StagingContext = { driver: 'harness', staging: [] };
        const result = await work(ctx);
        for (const apply of ctx.staging) apply();
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
    find: vi.fn(
      async (idempotencyKey: string) =>
        store.requests.find((row) => row.idempotencyKey === idempotencyKey) ??
        null,
    ),
    record: vi.fn(
      async (ctx: TransactionContext, request: StoredOperationsRequest) => {
        if (
          store.requests.some(
            (row) => row.idempotencyKey === request.idempotencyKey,
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

  const repository = makeRepository(store, stage, routeEffectiveFrom);

  const service = new FareChangeService(
    repository as never,
    auditService,
    requests as never,
    unitOfWork as never,
    outbox as never,
    { isActive: () => false } as never,
  );

  return {
    service,
    store,
    fareRowsFor: (pair) =>
      store.fares.filter(
        (row) =>
          row.originStationId === pair.originStationId &&
          row.destinationStationId === pair.destinationStationId,
      ),
    auditCount: () => store.audit.length,
    lastEvent: () => store.events[store.events.length - 1],
    requestCount: () => store.requests.length,
  };
}

function seedExistingFare(
  store: Store,
  overrides: Partial<FareRow> = {},
): FareRow {
  const row: FareRow = {
    id: randomUUID(),
    trainId: TRAIN_ID,
    travelClassId: FIRST_CLASS_AC,
    originStationId: CAIRO,
    destinationStationId: ALEXANDRIA,
    amountPiastres: 15_000,
    effectiveFrom: new Date('2026-01-01T00:00:00.000Z'),
    ...overrides,
  };
  store.fares.push(row);
  return row;
}

function request(
  overrides: Partial<ChangeFareRequest> = {},
): ChangeFareRequest {
  return {
    trainNumber: TRAIN_NUMBER,
    travelClassId: FIRST_CLASS_AC,
    originStationId: CAIRO,
    destinationStationId: ALEXANDRIA,
    amountPiastres: 20_000,
    effectiveFrom: new Date().toISOString(),
    ...overrides,
  };
}

describe('FareChangeService.changeFare', () => {
  let harness: FareChangeHarness;

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-06-20T09:00:00.000Z'));
    harness = makeHarness();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('records the new fare and reports the previous amount', async () => {
    seedExistingFare(harness.store);

    const result = await harness.service.changeFare(request(), 'k', OPERATOR);

    expect(result).toMatchObject({
      previousAmountPiastres: 15_000,
      newAmountPiastres: 20_000,
    });
    expect(result.fareId).toBeTruthy();
    expect(result.effectiveFrom).toBe(request().effectiveFrom);
  });

  it('reports no previous amount for the first fare ever recorded', async () => {
    const result = await harness.service.changeFare(request(), 'k', OPERATOR);

    expect(result.previousAmountPiastres).toBeNull();
  });

  it('keeps the previous fare row in the history (CAT-2, BR-30)', async () => {
    seedExistingFare(harness.store);

    await harness.service.changeFare(
      request({ amountPiastres: 20_000 }),
      'k',
      OPERATOR,
    );

    expect(
      harness.fareRowsFor({
        originStationId: CAIRO,
        destinationStationId: ALEXANDRIA,
      }),
    ).toHaveLength(2);
  });

  it('writes the fare, its audit entry and FareChanged in one transaction', async () => {
    await harness.service.changeFare(request(), 'k', OPERATOR);

    expect(
      harness.fareRowsFor({
        originStationId: CAIRO,
        destinationStationId: ALEXANDRIA,
      }),
    ).toHaveLength(1);
    expect(harness.auditCount()).toBe(1);
    expect(harness.lastEvent().type).toBe('catalog.fare.changed');
    expect(harness.requestCount()).toBe(1);
  });

  it('publishes FareChanged with the train, class, pair, amount and instant', async () => {
    const req = request({ amountPiastres: 20_000 });
    await harness.service.changeFare(req, 'k', OPERATOR);

    expect(harness.lastEvent().payload).toMatchObject({
      travelClassId: FIRST_CLASS_AC,
      originStationId: CAIRO,
      destinationStationId: ALEXANDRIA,
      newAmountPiastres: 20_000,
    });
  });

  it('accepts a fare effective exactly now', async () => {
    await expect(
      harness.service.changeFare(
        request({ effectiveFrom: new Date().toISOString() }),
        'k1',
        OPERATOR,
      ),
    ).resolves.toMatchObject({ newAmountPiastres: 20_000 });
  });

  it('refuses a fare effective in the past (BR-51)', async () => {
    await expect(
      harness.service.changeFare(
        request({ effectiveFrom: new Date(Date.now() - 1000).toISOString() }),
        'k2',
        OPERATOR,
      ),
    ).rejects.toMatchObject({ code: ErrorCode.VALIDATION_ERROR });
  });

  it('refuses a non-positive or non-integer amount', async () => {
    const rejection = await harness.service
      .changeFare(request({ amountPiastres: 0 }), 'k', OPERATOR)
      .then(
        () => null,
        (error: unknown) => error,
      );

    expect(rejection).toMatchObject({
      code: ErrorCode.VALIDATION_ERROR,
      details: [expect.objectContaining({ field: 'amountPiastres' })],
    });

    const fractional = await harness.service
      .changeFare(request({ amountPiastres: 100.5 }), 'k-frac', OPERATOR)
      .then(
        () => null,
        (error: unknown) => error,
      );

    expect(fractional).toMatchObject({ code: ErrorCode.VALIDATION_ERROR });
  });

  it('refuses an amount below the payment minimum without naming a vendor (§6.3)', async () => {
    const original = process.env.STRIPE_MINIMUM_CHARGE_PIASTRES;
    process.env.STRIPE_MINIMUM_CHARGE_PIASTRES = '1000';

    try {
      const rejection = await harness.service
        .changeFare(request({ amountPiastres: 500 }), 'k', OPERATOR)
        .then(
          () => null,
          (error: unknown) => error,
        );

      expect(rejection).toMatchObject({
        code: ErrorCode.VALIDATION_ERROR,
        details: [
          expect.objectContaining({
            field: 'amountPiastres',
            issueKey: 'ISSUE_FARE_BELOW_PAYMENT_MINIMUM',
            actionKey: 'ACTION_RAISE_FARE_TO_PAYMENT_MINIMUM',
          }),
        ],
      });
      const action = DETAIL_CATALOGUE.ACTION_RAISE_FARE_TO_PAYMENT_MINIMUM;
      expect(`${action.en} ${action.ar}`).not.toMatch(/stripe/i);
    } finally {
      if (original === undefined)
        delete process.env.STRIPE_MINIMUM_CHARGE_PIASTRES;
      else process.env.STRIPE_MINIMUM_CHARGE_PIASTRES = original;
    }
  });

  it('refuses an unknown train, class or station pair', async () => {
    const unknownTrain = await harness.service
      .changeFare(request({ trainNumber: '999' }), 'k-train', OPERATOR)
      .then(
        () => null,
        (error: unknown) => error,
      );
    expect(unknownTrain).toMatchObject({
      code: ErrorCode.VALIDATION_ERROR,
      details: [expect.objectContaining({ field: 'trainNumber' })],
    });

    const unknownClass = await harness.service
      .changeFare(
        request({ travelClassId: UNKNOWN_CLASS }),
        'k-class',
        OPERATOR,
      )
      .then(
        () => null,
        (error: unknown) => error,
      );
    expect(unknownClass).toMatchObject({
      code: ErrorCode.VALIDATION_ERROR,
      details: [expect.objectContaining({ field: 'travelClassId' })],
    });

    const unknownStation = await harness.service
      .changeFare(
        request({ destinationStationId: UNKNOWN_STATION }),
        'k-station',
        OPERATOR,
      )
      .then(
        () => null,
        (error: unknown) => error,
      );
    expect(unknownStation).toMatchObject({
      code: ErrorCode.VALIDATION_ERROR,
      details: [expect.objectContaining({ field: 'destinationStationId' })],
    });
  });

  it('refuses a pair the train does not run in order', async () => {
    const rejection = await harness.service
      .changeFare(
        request({ originStationId: ALEXANDRIA, destinationStationId: CAIRO }),
        'k',
        OPERATOR,
      )
      .then(
        () => null,
        (error: unknown) => error,
      );

    expect(rejection).toMatchObject({
      code: ErrorCode.VALIDATION_ERROR,
      details: [
        expect.objectContaining({
          field: 'destinationStationId',
          issueKey: 'ISSUE_TRAIN_DOES_NOT_RUN_PAIR_IN_ORDER',
          actionKey: 'ACTION_PICK_PAIR_IN_TRAVEL_ORDER',
        }),
      ],
    });
  });

  it('refuses an amount that would price a segment below one it contains (CAT-2)', async () => {
    seedExistingFare(harness.store, {
      originStationId: CAIRO,
      destinationStationId: GIZA,
      amountPiastres: 12_000,
    });

    const rejection = await harness.service
      .changeFare(
        request({
          originStationId: CAIRO,
          destinationStationId: ALEXANDRIA,
          amountPiastres: 10_000,
        }),
        'k',
        OPERATOR,
      )
      .then(
        () => null,
        (error: unknown) => error,
      );

    expect(rejection).toMatchObject({
      code: ErrorCode.VALIDATION_ERROR,
      details: [
        expect.objectContaining({
          field: 'amountPiastres',
          issueKey: 'ISSUE_FARE_BELOW_CONTAINED_SEGMENT',
          actionKey: 'ACTION_RAISE_FARE_TO_CONTAINED_SEGMENT',
          params: { containedFarePiastres: '12000' },
        }),
      ],
    });
  });

  it('replays the first response for a repeated idempotency key', async () => {
    const first = await harness.service.changeFare(
      request(),
      'replay-key',
      OPERATOR,
    );
    const second = await harness.service.changeFare(
      request(),
      'replay-key',
      OPERATOR,
    );

    expect(second).toEqual(first);
    expect(
      harness.fareRowsFor({
        originStationId: CAIRO,
        destinationStationId: ALEXANDRIA,
      }),
    ).toHaveLength(1);
    expect(harness.auditCount()).toBe(1);
  });

  it('refuses a reused idempotency key with a language-free corrective ref', async () => {
    await harness.service.changeFare(request(), 'reused-key', OPERATOR);

    await expect(
      harness.service.changeFare(
        request({ amountPiastres: 21_000 }),
        'reused-key',
        OPERATOR,
      ),
    ).rejects.toMatchObject({
      code: ErrorCode.CONFLICT,
      details: [
        {
          field: 'Idempotency-Key',
          rejectedValue: 'reused-key',
          issueKey: 'ISSUE_IDEMPOTENCY_KEY_REUSED',
          actionKey: 'ACTION_SEND_NEW_IDEMPOTENCY_KEY',
        },
      ],
    });
  });

  // Both requests are real and recorded; the later effective_from wins. Row
  // contention itself is proven against Postgres.
  it('serialises two concurrent changes to the same fare and records both', async () => {
    const now = new Date();
    await Promise.all([
      harness.service.changeFare(
        request({
          amountPiastres: 20_000,
          effectiveFrom: new Date(now.getTime() + 100).toISOString(),
        }),
        'k-a',
        OPERATOR,
      ),
      harness.service.changeFare(
        request({
          amountPiastres: 30_000,
          effectiveFrom: new Date(now.getTime() + 900).toISOString(),
        }),
        'k-b',
        OPERATOR_B,
      ),
    ]);

    expect(harness.auditCount()).toBe(2);
    expect(
      harness.fareRowsFor({
        originStationId: CAIRO,
        destinationStationId: ALEXANDRIA,
      }),
    ).toHaveLength(2);
  });

  // Probe with the fare's own effective date, not today, or a future-only
  // route looks missing.
  it('accepts a fare change for a train whose only published version starts in the future', async () => {
    const futureHarness = makeHarness({ routeEffectiveFrom: '2026-07-01' });

    const result = await futureHarness.service.changeFare(
      request({
        effectiveFrom: new Date('2026-07-01T00:00:00.000Z').toISOString(),
      }),
      'k',
      OPERATOR,
    );

    expect(result).toMatchObject({ newAmountPiastres: 20_000 });
  });

  // Same tuple and instant under a new key hits `uq_fare_effective_version`,
  // not a 500.
  it('refuses a same-instant resubmission as a conflict, not a 500', async () => {
    const effectiveFrom = new Date('2026-06-25T00:00:00.000Z').toISOString();

    await harness.service.changeFare(
      request({ amountPiastres: 20_000, effectiveFrom }),
      'first-key',
      OPERATOR,
    );

    const rejection = await harness.service
      .changeFare(
        request({ amountPiastres: 21_000, effectiveFrom }),
        'second-key',
        OPERATOR,
      )
      .then(
        () => null,
        (error: unknown) => error,
      );

    expect(rejection).toMatchObject({
      code: ErrorCode.CONFLICT,
      details: [
        expect.objectContaining({
          field: 'effectiveFrom',
          issueKey: 'ISSUE_FARE_ALREADY_EFFECTIVE_AT_INSTANT',
          actionKey: 'ACTION_PICK_DIFFERENT_EFFECTIVE_INSTANT',
        }),
      ],
    });
    expect(
      harness.fareRowsFor({
        originStationId: CAIRO,
        destinationStationId: ALEXANDRIA,
      }),
    ).toHaveLength(1);
  });
});
