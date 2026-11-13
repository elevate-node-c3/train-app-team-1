import { describe, expect, it, vi } from 'vitest';
import type { TransactionContext } from '@app/common/persistence/unit-of-work.port.js';

import { TimetableEntity } from '../timetables/entities/timetable.entity.js';
import {
  isEffectiveVersionOn,
  pickEffectiveTimetable,
  TimetableVersionService,
} from './timetable-version.service.js';

// `entityManagerOf` refuses fake contexts; unwrapping is all `supersede` needs.
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
      // Not live, however new.
      timetable({ version: 3, effectiveFrom: '2026-01-01', status: 'draft' }),
    ]);

    // The successor owns its effectiveFrom date.
    expect(await service.effectiveOn(TRAIN, '2026-06-20')).toMatchObject({
      version: 2,
    });
    // effective_until is inclusive.
    expect(await service.effectiveOn(TRAIN, '2026-06-19')).toMatchObject({
      version: 1,
    });
    expect(await service.effectiveOn(TRAIN, '2027-01-01')).toMatchObject({
      version: 2,
    });
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
    // Already closed; rewriting it would lose a real range.
    expect(history.effectiveUntil).toBe('2025-12-31');
    expect(saved).toEqual([live]);

    // End the predecessor the day before its successor, leaving no gap.
    expect(await service.effectiveOn(TRAIN, '2026-06-19')).toBe(live);
    expect(await service.effectiveOn(TRAIN, '2026-06-20')).toBeNull();
  });

  it('reports the latest version number for a train', async () => {
    // Withdrawn and draft count: the unique version constraint ignores status.
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

describe('isEffectiveVersionOn', () => {
  // Compare row IDs, not effectiveFrom/version pairs, to prevent duplicate generation.
  it('treats exactly one of two rows sharing a version as effective', () => {
    const first = timetable({
      id: 'tt-a',
      version: 1,
      effectiveFrom: '2026-06-10',
    });
    const second = timetable({
      id: 'tt-b',
      version: 1,
      effectiveFrom: '2026-06-10',
    });
    const rows = [first, second];

    const answers = rows.map((row) =>
      isEffectiveVersionOn(row, rows, '2026-06-20'),
    );

    expect(answers.filter(Boolean)).toHaveLength(1);
    expect(answers).toEqual([true, false]);
  });

  it('refuses a candidate another version owns the date', () => {
    const live = timetable({
      id: 'tt-v2',
      version: 2,
      effectiveFrom: '2026-06-22',
    });
    const superseded = timetable({
      id: 'tt-v1',
      version: 1,
      effectiveFrom: '2026-06-10',
    });
    const rows = [superseded, live];

    expect(isEffectiveVersionOn(live, rows, '2026-06-22')).toBe(true);
    expect(isEffectiveVersionOn(superseded, rows, '2026-06-22')).toBe(false);
    expect(isEffectiveVersionOn(superseded, rows, '2026-06-21')).toBe(true);
  });

  // Draft and withdrawn ranges may overlap published ones but are never effective.
  it('never resolves to a row that is not published', () => {
    const draft = timetable({
      id: 'tt-draft',
      version: 5,
      effectiveFrom: '2026-06-22',
      status: 'draft',
    });
    const withdrawn = timetable({
      id: 'tt-withdrawn',
      version: 4,
      effectiveFrom: '2026-06-21',
      status: 'withdrawn',
    });
    const live = timetable({ id: 'tt-live', version: 1 });
    const rows = [draft, withdrawn, live];

    expect(pickEffectiveTimetable(rows, '2026-06-23')).toBe(live);
    expect(isEffectiveVersionOn(draft, rows, '2026-06-23')).toBe(false);
    expect(isEffectiveVersionOn(withdrawn, rows, '2026-06-23')).toBe(false);
    expect(pickEffectiveTimetable([draft, withdrawn], '2026-06-23')).toBeNull();
  });
});
