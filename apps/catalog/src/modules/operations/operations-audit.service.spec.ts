import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';

import type { TransactionContext } from '@app/common/persistence/unit-of-work.port.js';

import type { OperationsAuditEntity } from './entities/operations-audit.entity.js';
import {
  OperationsAuditService,
  type AppendAuditInput,
} from './operations-audit.service.js';
import type { OperationsAuditFilter } from './operations-audit.types.js';

interface FakeContext extends TransactionContext {
  staging: OperationsAuditEntity[];
}

// The fake commits only successful work; PostgreSQL boundaries are tested separately.
function makeUnitOfWork(committed: OperationsAuditEntity[]) {
  const withTransaction = vi.fn(
    async (work: (ctx: FakeContext) => Promise<unknown>) => {
      const ctx: FakeContext = { driver: 'fake', staging: [] };
      const result = await work(ctx);
      committed.push(...ctx.staging);
      return result;
    },
  );
  return { withTransaction };
}

// Reads only committed rows, so a rollback is invisible to `list`.
function makeRepository(committed: OperationsAuditEntity[]) {
  return {
    append: vi.fn(async (ctx: FakeContext, entity: OperationsAuditEntity) => {
      ctx.staging.push(entity);
      return entity;
    }),
    list: vi.fn(async (filter: OperationsAuditFilter) => {
      let rows = committed.filter((row) => {
        if (filter.trainId && row.trainId !== filter.trainId) return false;
        if (filter.from && row.occurredAt < filter.from) return false;
        if (filter.to && row.occurredAt > filter.to) return false;
        return true;
      });

      rows = [...rows].sort(
        (a, b) =>
          b.occurredAt.getTime() - a.occurredAt.getTime() ||
          b.id.localeCompare(a.id),
      );

      let start = 0;
      if (filter.cursor) {
        const anchor = rows.findIndex((row) => row.id === filter.cursor);
        start = anchor === -1 ? rows.length : anchor + 1;
      }

      const entries = rows.slice(start, start + filter.limit);
      const hasMore = start + filter.limit < rows.length;

      return {
        entries,
        nextCursor: hasMore ? entries[entries.length - 1].id : null,
      };
    }),
  };
}

const TRAIN_A = '11111111-1111-4111-8111-111111111111';
const TRAIN_B = '22222222-2222-4222-8222-222222222222';
const ACTOR = '33333333-3333-4333-8333-333333333333';

function makeInput(
  overrides: Partial<AppendAuditInput> = {},
): AppendAuditInput {
  return {
    action: 'timetable.published',
    actorAccountId: ACTOR,
    trainId: TRAIN_A,
    before: null,
    after: { version: 1 },
    ticketsAffected: 0,
    correlationId: randomUUID(),
    ...overrides,
  };
}

function makeHarness() {
  const committed: OperationsAuditEntity[] = [];
  const repository = makeRepository(committed);
  const service = new OperationsAuditService(repository as never);
  const uow = makeUnitOfWork(committed);
  return { committed, repository, service, uow };
}

describe('OperationsAuditService', () => {
  it('records who, when, what, how many tickets and the correlation id', async () => {
    const { service, uow } = makeHarness();
    const request = makeInput({
      before: { version: 0 },
      after: { version: 1 },
      ticketsAffected: 0,
    });

    const entry = (await uow.withTransaction((ctx) =>
      service.append(ctx as never, request),
    )) as OperationsAuditEntity;

    expect(entry).toMatchObject({
      action: 'timetable.published',
      actorAccountId: ACTOR,
      trainId: TRAIN_A,
      before: { version: 0 },
      after: { version: 1 },
      ticketsAffected: 0,
      correlationId: request.correlationId,
    });
    expect(entry.id).toBeTruthy();
    expect(entry.occurredAt).toBeInstanceOf(Date);
  });

  it('writes the entry in the caller transaction, not its own', async () => {
    const { repository, service, uow } = makeHarness();
    let seenCtx: FakeContext | undefined;

    await uow.withTransaction(async (ctx) => {
      seenCtx = ctx as FakeContext;
      return service.append(ctx as never, makeInput());
    });

    expect(repository.append).toHaveBeenCalledWith(seenCtx, expect.anything());
    expect(uow.withTransaction).toHaveBeenCalledOnce();
  });

  // Changes and audit records must commit or roll back together.
  it('leaves no entry behind when the transaction rolls back', async () => {
    const { committed, service, uow } = makeHarness();

    await expect(
      uow.withTransaction(async (ctx) => {
        await service.append(ctx as never, makeInput());
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');

    expect(committed).toHaveLength(0);
    expect(await service.list({ limit: 10 })).toMatchObject({ entries: [] });
  });

  it('lists entries newest first', async () => {
    const { service, uow } = makeHarness();

    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
      await uow.withTransaction((ctx) =>
        service.append(ctx as never, makeInput({ correlationId: 'first' })),
      );

      vi.setSystemTime(new Date('2026-02-01T00:00:00Z'));
      await uow.withTransaction((ctx) =>
        service.append(ctx as never, makeInput({ correlationId: 'second' })),
      );

      const { entries } = await service.list({ limit: 10 });
      expect(entries.map((entry) => entry.correlationId)).toEqual([
        'second',
        'first',
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('filters by train and date range', async () => {
    const { service, uow } = makeHarness();

    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
      await uow.withTransaction((ctx) =>
        service.append(
          ctx as never,
          makeInput({ trainId: TRAIN_A, correlationId: 'a-jan' }),
        ),
      );

      vi.setSystemTime(new Date('2026-02-01T00:00:00Z'));
      await uow.withTransaction((ctx) =>
        service.append(
          ctx as never,
          makeInput({ trainId: TRAIN_B, correlationId: 'b-feb' }),
        ),
      );

      vi.setSystemTime(new Date('2026-03-01T00:00:00Z'));
      await uow.withTransaction((ctx) =>
        service.append(
          ctx as never,
          makeInput({ trainId: TRAIN_A, correlationId: 'a-mar' }),
        ),
      );

      const byTrain = await service.list({ trainId: TRAIN_A, limit: 10 });
      expect(byTrain.entries.map((entry) => entry.correlationId)).toEqual([
        'a-mar',
        'a-jan',
      ]);

      const byDateRange = await service.list({
        from: new Date('2026-01-15T00:00:00Z'),
        to: new Date('2026-02-15T00:00:00Z'),
        limit: 10,
      });
      expect(byDateRange.entries.map((entry) => entry.correlationId)).toEqual([
        'b-feb',
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('pages with a cursor', async () => {
    const { service, uow } = makeHarness();

    vi.useFakeTimers();
    try {
      const correlationIds = ['one', 'two', 'three'];
      for (let day = 0; day < correlationIds.length; day += 1) {
        vi.setSystemTime(new Date(2026, 0, day + 1));
        await uow.withTransaction((ctx) =>
          service.append(
            ctx as never,
            makeInput({ correlationId: correlationIds[day] }),
          ),
        );
      }

      const firstPage = await service.list({ limit: 2 });
      expect(firstPage.entries.map((entry) => entry.correlationId)).toEqual([
        'three',
        'two',
      ]);
      expect(firstPage.nextCursor).toBeTruthy();

      const secondPage = await service.list({
        limit: 2,
        cursor: firstPage.nextCursor!,
      });
      expect(secondPage.entries.map((entry) => entry.correlationId)).toEqual([
        'one',
      ]);
      expect(secondPage.nextCursor).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});
