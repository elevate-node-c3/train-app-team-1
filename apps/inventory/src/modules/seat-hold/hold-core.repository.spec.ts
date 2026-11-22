import { describe, expect, it, vi } from 'vitest';
import { TypeOrmUnitOfWork } from '@app/common/persistence/typeorm-unit-of-work.js';
import { HoldCoreRepository } from './hold-core.repository.js';

function fixture() {
  const query = vi.fn().mockResolvedValue([]);
  const unitOfWork = new TypeOrmUnitOfWork({
    ensureInitialized: async () => ({
      transaction: async (work: (manager: unknown) => unknown) =>
        work({ query }),
    }),
  } as never);
  return { query, unitOfWork, repository: new HoldCoreRepository() };
}

describe('HoldCoreRepository settlement safeguards', () => {
  it('rolls all writes back to a savepoint on a passenger exclusion violation', async () => {
    const { query, unitOfWork, repository } = fixture();
    const result = await unitOfWork.withTransaction((ctx) =>
      repository.attemptSettlement(ctx, async () => {
        await query('first leg write');
        throw {
          driverError: {
            code: '23P01',
            constraint: 'excl_seat_occupation_passenger_overlap',
          },
        };
      }),
    );
    expect(result).toBe('NO_SEATS');
    expect(query.mock.calls.map(([sql]) => sql)).toEqual([
      'SAVEPOINT hold_settlement',
      'first leg write',
      'ROLLBACK TO SAVEPOINT hold_settlement',
      'RELEASE SAVEPOINT hold_settlement',
    ]);
  });

  it('never disguises unrelated database faults as NO_SEATS', async () => {
    const { unitOfWork, repository } = fixture();
    const error = { code: '40P01' };
    await expect(
      unitOfWork.withTransaction((ctx) =>
        repository.attemptSettlement(ctx, async () => {
          throw error;
        }),
      ),
    ).rejects.toBe(error);
  });

  it('guards every persisted settlement decision against overwriting a refusal', async () => {
    const { query, unitOfWork, repository } = fixture();
    await unitOfWork.withTransaction(async (ctx) => {
      await repository.markHoldSold(ctx, 'hold', new Date(), 'REALLOCATED');
      await repository.recordNoSeats(ctx, 'hold', new Date());
    });
    const updates = query.mock.calls.filter(([sql]) =>
      sql.includes('UPDATE seat_hold_group'),
    );
    expect(updates).toHaveLength(2);
    for (const [sql] of updates)
      expect(sql).toContain('settlement_outcome IS NULL');
    expect(updates[0][1][2]).toBe('REALLOCATED');
  });

  it('uses one sorted unique union of trip locks', async () => {
    const { query, unitOfWork, repository } = fixture();
    query.mockResolvedValue([{ id: 'a' }, { id: 'b' }]);
    await unitOfWork.withTransaction((ctx) =>
      repository.lockTrips(ctx, ['b', 'a', 'b']),
    );
    expect(query.mock.calls[0][0]).toContain('ORDER BY id');
    expect(query.mock.calls[0][1]).toEqual([['a', 'b']]);
  });
});
