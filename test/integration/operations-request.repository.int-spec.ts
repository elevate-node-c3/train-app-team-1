import type { DataSource } from 'typeorm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { DataSourceInitializer } from '../../libs/common/src/persistence/data-source-initializer.js';
import { TypeOrmUnitOfWork } from '../../libs/common/src/persistence/typeorm-unit-of-work.js';

import { OperationsRequestRepository } from '../../apps/catalog/src/modules/operations/operations-request.repository.js';

import {
  catalogDataSource,
  closeCatalogDataSource,
} from './support/catalog-database.js';

/**
 * Use real TypeOrmUnitOfWork transactions and Postgres primary-key enforcement;
 * in-memory rollback and SQL reimplementations do not test this path.
 */

describe('the operations request store', () => {
  let source: DataSource;
  let repository: OperationsRequestRepository;
  let unitOfWork: TypeOrmUnitOfWork;

  beforeAll(async () => {
    source = await catalogDataSource();
    repository = new OperationsRequestRepository(source);
    unitOfWork = new TypeOrmUnitOfWork(new DataSourceInitializer(source));
  });

  beforeEach(async () => {
    await source.query('TRUNCATE TABLE operations_request');
  });

  afterAll(async () => {
    await closeCatalogDataSource();
  });

  const countRows = async (): Promise<number> => {
    const [{ count }] = (await source.query(
      'SELECT count(*)::int AS count FROM operations_request',
    )) as { count: number }[];
    return count;
  };

  describe('record, inside the caller transaction', () => {
    it('stores the row when the transaction commits, and find returns it', async () => {
      await unitOfWork.withTransaction((ctx) =>
        repository.record(ctx, {
          idempotencyKey: 'commit-key',
          fingerprint: 'fp-commit',
          responseJson: JSON.stringify({ versionId: 'v1' }),
        }),
      );

      expect(await countRows()).toBe(1);

      const found = await repository.find('commit-key');
      expect(found).toEqual({
        idempotencyKey: 'commit-key',
        fingerprint: 'fp-commit',
        responseJson: JSON.stringify({ versionId: 'v1' }),
      });
    });

    // Idempotency keys must commit or roll back with the operation.
    it('stores nothing when the transaction rejects', async () => {
      await expect(
        unitOfWork.withTransaction(async (ctx) => {
          await repository.record(ctx, {
            idempotencyKey: 'rollback-key',
            fingerprint: 'fp-rollback',
            responseJson: '{}',
          });
          throw new Error('boom');
        }),
      ).rejects.toThrow('boom');

      expect(await countRows()).toBe(0);
      expect(await repository.find('rollback-key')).toBeNull();
    });
  });

  describe('find', () => {
    it('returns null for a key never recorded', async () => {
      expect(await repository.find('unseen-key')).toBeNull();
    });
  });

  describe('the primary key', () => {
    it('rejects a second insert of an already-recorded key', async () => {
      await unitOfWork.withTransaction((ctx) =>
        repository.record(ctx, {
          idempotencyKey: 'dup-key',
          fingerprint: 'fp-first',
          responseJson: '{}',
        }),
      );

      await expect(
        unitOfWork.withTransaction((ctx) =>
          repository.record(ctx, {
            idempotencyKey: 'dup-key',
            fingerprint: 'fp-second',
            responseJson: '{}',
          }),
        ),
      ).rejects.toThrow(/duplicate key/i);

      expect(await countRows()).toBe(1);
      const found = await repository.find('dup-key');
      expect(found?.fingerprint).toBe('fp-first');
    });
  });
});
