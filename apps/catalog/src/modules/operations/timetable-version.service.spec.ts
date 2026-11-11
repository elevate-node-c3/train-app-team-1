import { describe, expect, it, vi } from 'vitest';
import type { TransactionContext } from '@app/common/persistence/unit-of-work.port.js';

import { TimetableEntity } from '../timetables/entities/timetable.entity.js';
import { TimetableVersionService } from './timetable-version.service.js';

// `entityManagerOf` refuses anything that is not the real adapter's context
// object, which a unit test has no way to build. Unwrapping is the only thing
// it does for `supersede`, so it is stubbed to exactly that.
vi.mock('@app/common/persistence/typeorm-unit-of-work.js', () => ({
  entityManagerOf: (ctx: { manager: unknown }) => ctx.manager,
}));

const TRAIN = '11111111-1111-4111-8111-111111111111';
const OTHER_TRAIN = '22222222-2222-4222-8222-222222222222';

function timetable(overrides: Partial<TimetableEntity>): TimetableEntity {
  return {
    id: `tt-${overrides.version ?? 1}`,
    train: { id: TRAIN },
    runningDays: [0, 1, 2, 3, 4, 5, 6],
    effectiveFrom: '2026-01-01',
    effectiveUntil: null,
    version: 1,
    status: 'published',
    ...overrides,
  } as TimetableEntity;
}

interface FindOptions {
  where: { train: { id: string }; status?: string };
  order?: { version?: 'ASC' | 'DESC' };
}

/**
 * A small honest fake: it applies the train and status filters the service
 * asks for, so a service that forgot either one fails here.
 */
function makeService(rows: TimetableEntity[]) {
  const saved: TimetableEntity[] = [];

  const matching = (options: FindOptions): TimetableEntity[] =>
    rows.filter(
      (row) =>
        row.train.id === options.where.train.id &&
        (options.where.status === undefined ||
          row.status === options.where.status),
    );

  const repository = {
    find: async (options: FindOptions) => matching(options),
    findOne: async (options: FindOptions) => {
      const found = [...matching(options)].sort((left, right) =>
        options.order?.version === 'DESC'
          ? right.version - left.version
          : left.version - right.version,
      );
      return found[0] ?? null;
    },
    save: async (row: TimetableEntity) => {
      saved.push(row);
      return row;
    },
  };

  const service = new TimetableVersionService(repository as never);
  const ctx = {
    driver: 'typeorm',
    manager: { getRepository: () => repository },
  } as unknown as TransactionContext;

  return { service, ctx, saved };
}

describe('TimetableVersionService', () => {
  it('resolves the version effective on a date', async () => {
    const { service } = makeService([
      timetable({
        version: 1,
        effectiveFrom: '2026-01-01',
        effectiveUntil: '2026-06-19',
      }),
      timetable({ version: 2, effectiveFrom: '2026-06-20' }),
      // Not live, and must never be chosen however new it looks.
      timetable({ version: 3, effectiveFrom: '2026-01-01', status: 'draft' }),
    ]);

    // The day the successor takes effect belongs to the successor.
    expect(await service.effectiveOn(TRAIN, '2026-06-20')).toMatchObject({
      version: 2,
    });
    // The day before is still the predecessor's -- `effective_until` is the
    // last day it applies, not the first day it does not.
    expect(await service.effectiveOn(TRAIN, '2026-06-19')).toMatchObject({
      version: 1,
    });
    expect(await service.effectiveOn(TRAIN, '2027-01-01')).toMatchObject({
      version: 2,
    });
    // Another train's dates are not this train's business.
    expect(await service.effectiveOn(OTHER_TRAIN, '2026-06-20')).toBeNull();
  });

  it('resolves nothing for a date before any version took effect', async () => {
    const { service } = makeService([
      timetable({ version: 1, effectiveFrom: '2026-01-01' }),
    ]);

    expect(await service.effectiveOn(TRAIN, '2025-12-31')).toBeNull();
  });

  it('bounds the previous version the day before the new one takes effect', async () => {
    const live = timetable({ version: 2, effectiveFrom: '2026-01-01' });
    const history = timetable({
      version: 1,
      effectiveFrom: '2025-01-01',
      effectiveUntil: '2025-12-31',
    });
    const { service, ctx, saved } = makeService([history, live]);

    await service.supersede(ctx, TRAIN, '2026-06-20');

    expect(live.effectiveUntil).toBe('2026-06-19');
    // Already closed before the new version starts, so there is nothing to
    // bound and rewriting it would lose a real range.
    expect(history.effectiveUntil).toBe('2025-12-31');
    expect(saved).toEqual([live]);

    // The point of the day-before: the bounded version still owns the last day
    // before its successor starts, so no day is left without one.
    expect(await service.effectiveOn(TRAIN, '2026-06-19')).toBe(live);
    expect(await service.effectiveOn(TRAIN, '2026-06-20')).toBeNull();
  });

  it('reports the latest version number for a train', async () => {
    // Withdrawn and draft rows count: uq_timetable_train_version does not care
    // what status the row it collides with has.
    const { service } = makeService([
      timetable({ version: 1, status: 'withdrawn' }),
      timetable({ version: 3, status: 'draft' }),
      timetable({ version: 2, status: 'published' }),
      timetable({ version: 9, train: { id: OTHER_TRAIN } as never }),
    ]);

    expect(await service.latestVersionNumber(TRAIN)).toBe(3);
  });

  it('reports version 0 for a train with no timetable', async () => {
    const { service } = makeService([]);

    expect(await service.latestVersionNumber(TRAIN)).toBe(0);
  });
});
