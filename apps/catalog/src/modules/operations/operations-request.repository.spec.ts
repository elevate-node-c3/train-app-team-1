import { describe, expect, it } from 'vitest';
import type { DataSource, EntityManager } from 'typeorm';

import { DataSourceInitializer } from '@app/common/persistence/data-source-initializer.js';
import { TypeOrmUnitOfWork } from '@app/common/persistence/typeorm-unit-of-work.js';

import { OperationsRequestEntity } from './entities/operations-request.entity.js';
import {
  OperationsRequestRepository,
  fingerprintOf,
} from './operations-request.repository.js';

/**
 * A committed store, plus a fake `DataSource.transaction` that only merges
 * a transaction's writes into it once the work resolves. This proves
 * `record` reads and writes through the `ctx` it is given -- including that
 * nothing it wrote during a rejected transaction becomes visible. The real
 * commit/rollback boundary (a Postgres transaction actually rolling back) is
 * proven separately in `test/integration/operations-request.repository.int-spec.ts`,
 * against the real TypeOrmUnitOfWork and the real database.
 */
function makeHarness() {
  const committed = new Map<string, OperationsRequestEntity>();

  const dataSource = {
    isInitialized: true,
    getRepository: () => ({
      findOne: async ({
        where: { idempotencyKey },
      }: {
        where: { idempotencyKey: string };
      }) => committed.get(idempotencyKey) ?? null,
    }),
    transaction: async (work: (manager: EntityManager) => Promise<unknown>) => {
      const staged = new Map<string, OperationsRequestEntity>();
      const manager = {
        getRepository: () => ({
          insert: async (entity: OperationsRequestEntity) => {
            if (staged.has(entity.idempotencyKey) || committed.has(entity.idempotencyKey)) {
              throw new Error('duplicate key value violates unique constraint');
            }
            staged.set(entity.idempotencyKey, entity);
            return entity;
          },
        }),
      } as unknown as EntityManager;

      // Only reached if `work` resolves -- a throw skips this line, so
      // nothing staged during a rejected transaction ever becomes visible.
      const result = await work(manager);
      for (const [key, value] of staged) committed.set(key, value);
      return result;
    },
  } as unknown as DataSource;

  const repository = new OperationsRequestRepository(dataSource);
  const unitOfWork = new TypeOrmUnitOfWork(
    new DataSourceInitializer(dataSource),
  );

  return { repository, unitOfWork, committed };
}

describe('OperationsRequestRepository', () => {
  it('records a key with its fingerprint and response', async () => {
    const { repository, unitOfWork } = makeHarness();

    await unitOfWork.withTransaction((ctx) =>
      repository.record(ctx, {
        idempotencyKey: 'key-1',
        fingerprint: 'fp-1',
        responseJson: '{"ok":true}',
      }),
    );

    const stored = await repository.find('key-1');
    expect(stored).toEqual({
      idempotencyKey: 'key-1',
      fingerprint: 'fp-1',
      responseJson: '{"ok":true}',
    });
  });

  it('finds nothing for an unseen key', async () => {
    const { repository } = makeHarness();

    expect(await repository.find('never-seen')).toBeNull();
  });

  it('records inside the caller transaction', async () => {
    const { repository, unitOfWork } = makeHarness();
    let seenManager: EntityManager | undefined;

    await unitOfWork.withTransaction(async (ctx) => {
      seenManager = (ctx as unknown as { manager: EntityManager }).manager;
      return repository.record(ctx, {
        idempotencyKey: 'key-2',
        fingerprint: 'fp-2',
        responseJson: '{}',
      });
    });

    // record wrote through the exact manager the caller's transaction
    // opened, not one of its own.
    expect(seenManager).toBeDefined();
    expect(await repository.find('key-2')).toMatchObject({
      idempotencyKey: 'key-2',
    });
  });

  // The property that makes the key trustworthy: a crash between commit and
  // response must not leave a half-recorded key behind.
  it('records nothing when the transaction rolls back', async () => {
    const { repository, unitOfWork, committed } = makeHarness();

    await expect(
      unitOfWork.withTransaction(async (ctx) => {
        await repository.record(ctx, {
          idempotencyKey: 'key-3',
          fingerprint: 'fp-3',
          responseJson: '{}',
        });
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');

    expect(committed.has('key-3')).toBe(false);
    expect(await repository.find('key-3')).toBeNull();
  });
});

describe('fingerprintOf', () => {
  it('is stable across key order', () => {
    expect(fingerprintOf({ a: 1, b: 2 })).toBe(fingerprintOf({ b: 2, a: 1 }));
  });

  // Review Focus 3. Reusing a key for different content is a client bug;
  // replaying the first response would hide it.
  it('differs when any value differs', () => {
    expect(fingerprintOf({ a: 1 })).not.toBe(fingerprintOf({ a: 2 }));
  });

  it('is stable across key order inside nested objects, but sensitive to array order', () => {
    const left = { a: 1, nested: { x: 1, y: 2 }, stops: ['A', 'B'] };
    const right = { nested: { y: 2, x: 1 }, a: 1, stops: ['A', 'B'] };
    const reordered = { ...left, stops: ['B', 'A'] };

    expect(fingerprintOf(left)).toBe(fingerprintOf(right));
    expect(fingerprintOf(left)).not.toBe(fingerprintOf(reordered));
  });

  it('treats an undefined-valued key the same as an absent one', () => {
    expect(fingerprintOf({ a: 1, b: undefined })).toBe(fingerprintOf({ a: 1 }));
  });

  it('is sensitive to a number changing, including across int/float', () => {
    expect(fingerprintOf({ price: 100 })).not.toBe(fingerprintOf({ price: 100.5 }));
  });
});
