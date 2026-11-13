import { describe, expect, it, vi } from 'vitest';

import { TimetableEntity } from '../timetables/entities/timetable.entity.js';
import { DatedTripEntity } from './entities/dated-trip.entity.js';
import { TripsService } from './trips.service.js';

const TRAIN = '11111111-1111-4111-8111-111111111111';
const SERVICE_DATE = '2026-06-20';

const timetable = {
  id: 'tt-1',
  version: 1,
  train: { id: TRAIN },
} as TimetableEntity;

const existing = { id: 'trip-1', status: 'published' } as DatedTripEntity;

/** A unique violation on uq_dated_trip_train_date, as the pg driver raises it. */
function uniqueViolation(): Error {
  return Object.assign(new Error('duplicate key value'), { code: '23505' });
}

/** The same, wrapped by TypeORM's QueryFailedError. */
function wrappedUniqueViolation(): Error {
  return Object.assign(new Error('duplicate key value'), {
    driverError: { code: '23505' },
  });
}

function makeService(options: {
  findOne: unknown[];
  transaction?: () => Promise<unknown>;
}) {
  const findOne = vi.fn();
  for (const result of options.findOne) {
    findOne.mockResolvedValueOnce(result);
  }

  const withTransaction = vi.fn(options.transaction ?? (async () => existing));

  const service = new TripsService(
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    { withTransaction } as never,
    {} as never,
    { findOne } as never,
    {} as never,
  );

  return { service, findOne, withTransaction };
}

describe('createDatedTrip idempotency', () => {
  it('returns the existing trip without opening a transaction', async () => {
    const { service, withTransaction } = makeService({ findOne: [existing] });

    await expect(
      service.createDatedTrip(timetable, SERVICE_DATE),
    ).resolves.toBe(existing);

    // Repeated ticks must neither write nor emit another event for an existing trip.
    expect(withTransaction).not.toHaveBeenCalled();
  });

  it('yields to the instance that inserted the same train and date first', async () => {
    const { service, withTransaction } = makeService({
      findOne: [null, existing],
      transaction: () => Promise.reject(uniqueViolation()),
    });

    await expect(
      service.createDatedTrip(timetable, SERVICE_DATE),
    ).resolves.toBe(existing);

    expect(withTransaction).toHaveBeenCalledOnce();
  });

  it("recognises the violation through TypeORM's wrapper", async () => {
    const { service } = makeService({
      findOne: [null, existing],
      transaction: () => Promise.reject(wrappedUniqueViolation()),
    });

    await expect(
      service.createDatedTrip(timetable, SERVICE_DATE),
    ).resolves.toBe(existing);
  });

  it('propagates a failure that is not a duplicate', async () => {
    // Propagate real failures; do not hide them as another instance's successful insert.
    const { service } = makeService({
      findOne: [null, existing],
      transaction: () => Promise.reject(new Error('outbox insert failed')),
    });

    await expect(
      service.createDatedTrip(timetable, SERVICE_DATE),
    ).rejects.toThrow('outbox insert failed');
  });

  it('propagates a duplicate that left no trip behind', async () => {
    const { service } = makeService({
      findOne: [null, null],
      transaction: () => Promise.reject(uniqueViolation()),
    });

    await expect(
      service.createDatedTrip(timetable, SERVICE_DATE),
    ).rejects.toThrow('duplicate key value');
  });
});
