import { describe, expect, it, vi } from 'vitest';
import type { EventEnvelope } from '@app/contracts';
import { TypeOrmUnitOfWork } from '@app/common/persistence/typeorm-unit-of-work.js';
import {
  INSERT_OUTBOX_BATCH_SQL,
  INSERT_OUTBOX_SQL,
  MARK_OUTBOX_PUBLISHED_SQL,
  MARK_OUTBOX_BATCH_PUBLISHED_SQL,
  RECORD_OUTBOX_FAILURE_SQL,
  TypeOrmOutboxRepository,
  appendParams,
  type OutboxPort,
} from '@app/messaging';

const EVENT: EventEnvelope = {
  id: '11111111-1111-4111-8111-111111111111',
  type: 'inventory.hold.expired',
  version: 1,
  occurredAt: '2026-11-15T10:00:00.000Z',
  correlationId: 'hold-correlation',
  producer: 'inventory',
  payload: { holdId: 'hold-1', state: 'expired' },
};

function harness() {
  const query = vi.fn(async (_sql: string, _params?: unknown[]) => []);
  const manager = { query };
  const transaction = vi.fn(
    async (work: (value: unknown) => Promise<unknown>) => work(manager),
  );
  const initializer = {
    ensureInitialized: vi.fn(async () => ({ transaction })),
    isConfigured: true,
  };
  return {
    query,
    transaction,
    initializer,
    outbox: new TypeOrmOutboxRepository(initializer as any),
    unitOfWork: new TypeOrmUnitOfWork(initializer as any),
  };
}

describe('TypeOrmOutboxRepository', () => {
  it('retains append and batches through the caller transaction manager', async () => {
    const h = harness();
    const port: OutboxPort = h.outbox;
    const events: readonly EventEnvelope[] = [
      EVENT,
      { ...EVENT, id: '22222222-2222-4222-8222-222222222222' },
    ];

    await h.unitOfWork.withTransaction(async (ctx) => {
      await port.append(ctx, EVENT);
      await port.appendBatch(ctx, events);
    });

    expect(h.initializer.ensureInitialized).toHaveBeenCalledTimes(1);
    expect(h.transaction).toHaveBeenCalledTimes(1);
    expect(h.query).toHaveBeenCalledTimes(2);
    expect(h.query).toHaveBeenNthCalledWith(1, INSERT_OUTBOX_SQL, [
      EVENT.id,
      EVENT.type,
      EVENT.version,
      EVENT.type,
      JSON.stringify(EVENT.payload),
      EVENT.correlationId,
      EVENT.producer,
      EVENT.occurredAt,
    ]);
    expect(h.query).toHaveBeenNthCalledWith(2, INSERT_OUTBOX_BATCH_SQL, [
      JSON.stringify(events.map(appendParams)),
    ]);
  });

  it('does no query for an empty batch', async () => {
    const h = harness();
    await h.unitOfWork.withTransaction((ctx) => h.outbox.appendBatch(ctx, []));
    expect(h.query).not.toHaveBeenCalled();
  });

  it('marks only confirmed IDs in one post-confirm database-clock statement', async () => {
    const h = harness();
    const ids = [EVENT.id, '22222222-2222-4222-8222-222222222222'];
    await h.unitOfWork.withTransaction(async (ctx) => {
      await h.outbox.markPublishedBatch(ctx, []);
      await h.outbox.markPublishedBatch(ctx, ids);
    });
    expect(h.query).toHaveBeenCalledExactlyOnceWith(
      MARK_OUTBOX_BATCH_PUBLISHED_SQL,
      [ids],
    );
    expect(MARK_OUTBOX_BATCH_PUBLISHED_SQL).toContain(
      'published_at = clock_timestamp()',
    );
    expect(MARK_OUTBOX_BATCH_PUBLISHED_SQL).toContain('published_at IS NULL');
  });

  it('keeps a 10k batch to one statement and one parameter', async () => {
    const h = harness();
    const events: readonly EventEnvelope[] = Array.from(
      { length: 10_000 },
      (_, index) => ({
        ...EVENT,
        id: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
      }),
    );

    await h.unitOfWork.withTransaction((ctx) =>
      h.outbox.appendBatch(ctx, events),
    );

    expect(h.query).toHaveBeenCalledTimes(1);
    const [sql, params] = h.query.mock.calls[0];
    expect(sql).toBe(INSERT_OUTBOX_BATCH_SQL);
    expect(params).toHaveLength(1);
    const rows = JSON.parse(String(params![0]));
    expect(rows).toHaveLength(events.length);
    expect(rows[0]).toEqual(appendParams(events[0]));
    expect(rows.at(-1)).toEqual(appendParams(events.at(-1)!));
  });

  it('rejects a foreign transaction rather than opening a second one', async () => {
    const h = harness();
    await expect(
      h.outbox.appendBatch({ driver: 'fake' }, [EVENT]),
    ).rejects.toThrow('transaction context');
    expect(h.initializer.ensureInitialized).not.toHaveBeenCalled();
    expect(h.query).not.toHaveBeenCalled();
  });

  it('records publication and backoff using the PostgreSQL wall clock', async () => {
    const h = harness();
    await h.unitOfWork.withTransaction(async (ctx) => {
      await h.outbox.markPublished(ctx, EVENT.id);
      await h.outbox.recordFailure(ctx, EVENT.id, 'message nacked', 250);
    });

    expect(h.query).toHaveBeenNthCalledWith(1, MARK_OUTBOX_PUBLISHED_SQL, [
      EVENT.id,
    ]);
    expect(h.query).toHaveBeenNthCalledWith(2, RECORD_OUTBOX_FAILURE_SQL, [
      EVENT.id,
      250,
      'message nacked',
    ]);
    expect(MARK_OUTBOX_PUBLISHED_SQL).toContain(
      'published_at = clock_timestamp()',
    );
    expect(RECORD_OUTBOX_FAILURE_SQL).toContain(
      "clock_timestamp() + ($2::double precision * interval '1 millisecond')",
    );
    expect(MARK_OUTBOX_PUBLISHED_SQL).not.toMatch(/\bnow\(\)/);
    expect(RECORD_OUTBOX_FAILURE_SQL).not.toMatch(/\bnow\(\)/);
  });

  it('does not swallow an insert failure inside the caller transaction', async () => {
    const h = harness();
    h.query.mockRejectedValueOnce(new Error('duplicate key'));
    await expect(
      h.unitOfWork.withTransaction((ctx) => h.outbox.appendBatch(ctx, [EVENT])),
    ).rejects.toThrow('duplicate key');
    expect(h.query).toHaveBeenCalledTimes(1);
  });
});
