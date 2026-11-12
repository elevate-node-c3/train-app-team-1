import { randomUUID } from 'node:crypto';
import type { DataSource } from 'typeorm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { DataSourceInitializer } from '../../libs/common/src/persistence/data-source-initializer.js';
import { TypeOrmUnitOfWork } from '../../libs/common/src/persistence/typeorm-unit-of-work.js';
import type { TransactionContext } from '../../libs/common/src/persistence/unit-of-work.port.js';

import { OperationsAuditEntity } from '../../apps/catalog/src/modules/operations/entities/operations-audit.entity.js';
import { OperationsAuditRepository } from '../../apps/catalog/src/modules/operations/operations-audit.repository.js';

import { catalogDataSource, closeCatalogDataSource } from './support/catalog-database.js';

/**
 * The append-only audit trail, against real Postgres.
 *
 * BR-52's property -- no change without its record, no record without its
 * change -- is a fact about the database (ACID) and about `append` honouring
 * the `ctx` it is given, not about anything a mocked unit of work can prove.
 * Only a real `TypeOrmUnitOfWork`, opening a real transaction against this
 * table, can show a rejected transaction leaving no row. The trigger is a
 * database object; only a real `UPDATE`/`DELETE` against it proves it fires.
 */

const TRAIN_A = '11111111-1111-4111-8111-111111111111';
const TRAIN_B = '22222222-2222-4222-8222-222222222222';
const ACTOR = '33333333-3333-4333-8333-333333333333';

function row(overrides: Partial<OperationsAuditEntity> = {}): OperationsAuditEntity {
  const entity = new OperationsAuditEntity();
  entity.id = randomUUID();
  entity.action = 'timetable.published';
  entity.actorAccountId = ACTOR;
  entity.trainId = TRAIN_A;
  entity.before = null;
  entity.after = { version: 1 };
  entity.ticketsAffected = 0;
  entity.correlationId = randomUUID();
  entity.occurredAt = new Date();
  return Object.assign(entity, overrides);
}

describe('the operations audit trail', () => {
  let source: DataSource;
  let repository: OperationsAuditRepository;
  let unitOfWork: TypeOrmUnitOfWork;

  beforeAll(async () => {
    source = await catalogDataSource();
    repository = new OperationsAuditRepository(source);
    unitOfWork = new TypeOrmUnitOfWork(new DataSourceInitializer(source));
  });

  beforeEach(async () => {
    // Not DELETE: the table is append-only, and the trigger under test would
    // reject it. TRUNCATE bypasses row-level triggers entirely.
    await source.query('TRUNCATE TABLE operations_audit');
  });

  afterAll(async () => {
    await closeCatalogDataSource();
  });

  const countRows = async (): Promise<number> => {
    const [{ count }] = (await source.query(
      'SELECT count(*)::int AS count FROM operations_audit',
    )) as { count: number }[];
    return count;
  };

  describe('append, inside the caller transaction', () => {
    it('leaves exactly one row, with every field, when the transaction commits', async () => {
      const entry = row({
        before: { version: 0 },
        after: { version: 1 },
        correlationId: 'corr-commit',
      });

      await unitOfWork.withTransaction((ctx) => repository.append(ctx, entry));

      expect(await countRows()).toBe(1);

      const [persisted] = await source.query(
        'SELECT * FROM operations_audit WHERE id = $1',
        [entry.id],
      );
      expect(persisted).toMatchObject({
        action: 'timetable.published',
        actor_account_id: ACTOR,
        train_id: TRAIN_A,
        before: { version: 0 },
        after: { version: 1 },
        tickets_affected: 0,
        correlation_id: 'corr-commit',
      });
    });

    // BR-52's teeth: the property a mocked unit of work cannot prove.
    it('leaves no row when the transaction rejects', async () => {
      const entry = row({ correlationId: 'corr-rollback' });

      await expect(
        unitOfWork.withTransaction(async (ctx) => {
          await repository.append(ctx, entry);
          throw new Error('boom');
        }),
      ).rejects.toThrow('boom');

      expect(await countRows()).toBe(0);
      const found = await source.query(
        'SELECT 1 FROM operations_audit WHERE id = $1',
        [entry.id],
      );
      expect(found).toEqual([]);
    });
  });

  describe('append-only trigger', () => {
    it('rejects UPDATE and DELETE against an inserted row', async () => {
      const entry = row({ correlationId: 'corr-trigger' });
      await unitOfWork.withTransaction((ctx) => repository.append(ctx, entry));

      await expect(
        source.query(
          'UPDATE operations_audit SET tickets_affected = 1 WHERE id = $1',
          [entry.id],
        ),
      ).rejects.toThrow(/append-only/);

      await expect(
        source.query('DELETE FROM operations_audit WHERE id = $1', [entry.id]),
      ).rejects.toThrow(/append-only/);

      expect(await countRows()).toBe(1);
      const [persisted] = await source.query(
        'SELECT tickets_affected FROM operations_audit WHERE id = $1',
        [entry.id],
      );
      expect(persisted.tickets_affected).toBe(0);
    });
  });

  describe('list', () => {
    async function appendAll(entries: OperationsAuditEntity[]): Promise<void> {
      for (const entry of entries) {
        await unitOfWork.withTransaction((ctx) => repository.append(ctx, entry));
      }
    }

    it('returns entries newest first', async () => {
      const older = row({
        correlationId: 'older',
        occurredAt: new Date('2026-01-01T00:00:00Z'),
      });
      const newer = row({
        correlationId: 'newer',
        occurredAt: new Date('2026-02-01T00:00:00Z'),
      });
      await appendAll([older, newer]);

      const { entries } = await repository.list({ limit: 10 });

      expect(entries.map((entry) => entry.correlationId)).toEqual([
        'newer',
        'older',
      ]);
    });

    it('filters by trainId', async () => {
      await appendAll([
        row({ trainId: TRAIN_A, correlationId: 'a' }),
        row({ trainId: TRAIN_B, correlationId: 'b' }),
      ]);

      const { entries } = await repository.list({ trainId: TRAIN_A, limit: 10 });

      expect(entries.map((entry) => entry.correlationId)).toEqual(['a']);
    });

    it('filters by a from/to date range', async () => {
      await appendAll([
        row({ correlationId: 'jan', occurredAt: new Date('2026-01-01T00:00:00Z') }),
        row({ correlationId: 'feb', occurredAt: new Date('2026-02-01T00:00:00Z') }),
        row({ correlationId: 'mar', occurredAt: new Date('2026-03-01T00:00:00Z') }),
      ]);

      const { entries } = await repository.list({
        from: new Date('2026-01-15T00:00:00Z'),
        to: new Date('2026-02-15T00:00:00Z'),
        limit: 10,
      });

      expect(entries.map((entry) => entry.correlationId)).toEqual(['feb']);
    });

    // No existing test combined both narrowings in one call -- the review's
    // own finding. A WHERE clause built by conditionally appending fragments
    // is exactly the kind of code where two filters stop composing.
    it('filters by trainId and a date range together', async () => {
      await appendAll([
        row({
          trainId: TRAIN_A,
          correlationId: 'a-jan',
          occurredAt: new Date('2026-01-01T00:00:00Z'),
        }),
        row({
          trainId: TRAIN_A,
          correlationId: 'a-feb',
          occurredAt: new Date('2026-02-01T00:00:00Z'),
        }),
        row({
          trainId: TRAIN_B,
          correlationId: 'b-feb',
          occurredAt: new Date('2026-02-01T00:00:00Z'),
        }),
      ]);

      const { entries } = await repository.list({
        trainId: TRAIN_A,
        from: new Date('2026-01-15T00:00:00Z'),
        to: new Date('2026-02-15T00:00:00Z'),
        limit: 10,
      });

      expect(entries.map((entry) => entry.correlationId)).toEqual(['a-feb']);
    });

    it('pages with a cursor across a page boundary, including a tie on occurred_at', async () => {
      const sameInstant = new Date('2026-02-01T00:00:00Z');
      // Two ids, deliberately ordered so the ">"-first one is the one the
      // keyset's `id DESC` tie-break must return before the other.
      const [idLow, idHigh] = [randomUUID(), randomUUID()].sort();

      const newest = row({
        correlationId: 'newest',
        occurredAt: new Date('2026-03-01T00:00:00Z'),
      });
      const tiedHigh = row({
        id: idHigh,
        correlationId: 'tied-high',
        occurredAt: sameInstant,
      });
      const tiedLow = row({
        id: idLow,
        correlationId: 'tied-low',
        occurredAt: sameInstant,
      });
      // Inserted out of final-order sequence on purpose: nothing about
      // insertion order should matter in a query ordered by occurred_at, id.
      await appendAll([tiedLow, newest, tiedHigh]);

      const firstPage = await repository.list({ limit: 2 });
      expect(firstPage.entries.map((entry) => entry.correlationId)).toEqual([
        'newest',
        'tied-high',
      ]);
      expect(firstPage.nextCursor).toBe(idHigh);

      const secondPage = await repository.list({
        limit: 2,
        cursor: firstPage.nextCursor!,
      });
      expect(secondPage.entries.map((entry) => entry.correlationId)).toEqual([
        'tied-low',
      ]);
      expect(secondPage.nextCursor).toBeNull();
    });
  });
});
