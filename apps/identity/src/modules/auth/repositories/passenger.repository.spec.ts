import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DataSource, EntityManager, Repository, SelectQueryBuilder } from 'typeorm';
import type { TransactionContext } from '@app/common/persistence/unit-of-work.port.js';
import { PassengerEntity } from '../entities/passenger.entity.js';
import { PassengerRepository } from './passenger.repository.js';
import {
  BOOKING_TICKET_CHECK,
  StubBookingTicketCheckAdapter,
} from '../booking-ticket-check.adapter.js';

vi.mock('@app/common/persistence/typeorm-unit-of-work.js', () => ({
  entityManagerOf: vi.fn((ctx: TransactionContext) => (ctx as any).manager ?? ctx),
}));

describe('PassengerRepository', () => {
  let repository: PassengerRepository;
  let mockDataSource: DataSource;
  let mockEntityManager: EntityManager;
  let mockEntityRepository: Repository<PassengerEntity>;
  let mockQueryBuilder: SelectQueryBuilder<PassengerEntity>;
  let mockCtx: TransactionContext;

  beforeEach(() => {
    mockQueryBuilder = {
      where: vi.fn().mockReturnThis(),
      andWhere: vi.fn().mockReturnThis(),
      orderBy: vi.fn().mockReturnThis(),
      addOrderBy: vi.fn().mockReturnThis(),
      setLock: vi.fn().mockReturnThis(),
      getMany: vi.fn().mockResolvedValue([]),
      getOne: vi.fn().mockResolvedValue(null),
    } as unknown as SelectQueryBuilder<PassengerEntity>;

    mockEntityRepository = {
      createQueryBuilder: vi.fn().mockReturnValue(mockQueryBuilder),
      count: vi.fn().mockResolvedValue(0),
      delete: vi.fn().mockResolvedValue({ affected: 1, raw: [] }),
    } as unknown as Repository<PassengerEntity>;

    mockEntityManager = {
      getRepository: vi.fn().mockReturnValue(mockEntityRepository),
      delete: vi.fn().mockResolvedValue({ affected: 1, raw: [] }),
      insert: vi.fn().mockResolvedValue(undefined),
      update: vi.fn().mockResolvedValue(undefined),
    } as unknown as EntityManager;

    mockDataSource = {
      getRepository: vi.fn().mockReturnValue(mockEntityRepository),
      manager: mockEntityManager,
    } as unknown as DataSource;

    mockCtx = {
      driver: 'typeorm',
      manager: mockEntityManager,
    } as unknown as TransactionContext;

    repository = new PassengerRepository(mockDataSource);
  });

  describe('findAllByAccountId', () => {
    it('orders by is_self DESC, created_at ASC with context', async () => {
      const passengers = [
        { id: 'p1', accountId: 'acc-1', isSelf: true, createdAt: new Date() },
        { id: 'p2', accountId: 'acc-1', isSelf: false, createdAt: new Date() },
      ] as PassengerEntity[];
      (mockQueryBuilder.getMany as any).mockResolvedValue(passengers);

      const result = await repository.findAllByAccountId(mockCtx, 'acc-1');

      expect(mockEntityManager.getRepository).toHaveBeenCalledWith(PassengerEntity);
      expect(mockEntityRepository.createQueryBuilder).toHaveBeenCalledWith('passenger');
      expect(mockQueryBuilder.where).toHaveBeenCalledWith('passenger.account_id = :accountId', {
        accountId: 'acc-1',
      });
      expect(mockQueryBuilder.orderBy).toHaveBeenCalledWith('passenger.is_self', 'DESC');
      expect(mockQueryBuilder.addOrderBy).toHaveBeenCalledWith('passenger.created_at', 'ASC');
      expect(result).toEqual(passengers);
    });

    it('uses dataSource when context is null', async () => {
      await repository.findAllByAccountId(null, 'acc-1');

      expect(mockDataSource.getRepository).toHaveBeenCalledWith(PassengerEntity);
      expect(mockQueryBuilder.where).toHaveBeenCalledWith('passenger.account_id = :accountId', {
        accountId: 'acc-1',
      });
      expect(mockQueryBuilder.orderBy).toHaveBeenCalledWith('passenger.is_self', 'DESC');
      expect(mockQueryBuilder.addOrderBy).toHaveBeenCalledWith('passenger.created_at', 'ASC');
    });
  });

  describe('findByIdAndAccountId', () => {
    it('filters by id and accountId with context', async () => {
      const passenger = { id: 'p1', accountId: 'acc-1' } as PassengerEntity;
      (mockQueryBuilder.getOne as any).mockResolvedValue(passenger);

      const result = await repository.findByIdAndAccountId(mockCtx, 'p1', 'acc-1');

      expect(mockEntityManager.getRepository).toHaveBeenCalledWith(PassengerEntity);
      expect(mockEntityRepository.createQueryBuilder).toHaveBeenCalledWith('passenger');
      expect(mockQueryBuilder.where).toHaveBeenCalledWith('passenger.id = :id', { id: 'p1' });
      expect(mockQueryBuilder.andWhere).toHaveBeenCalledWith('passenger.account_id = :accountId', {
        accountId: 'acc-1',
      });
      expect(mockQueryBuilder.setLock).not.toHaveBeenCalled();
      expect(result).toEqual(passenger);
    });

    it('sets pessimistic_write lock when forUpdate is true and context is provided', async () => {
      const passenger = { id: 'p1', accountId: 'acc-1' } as PassengerEntity;
      (mockQueryBuilder.getOne as any).mockResolvedValue(passenger);

      const result = await repository.findByIdAndAccountId(mockCtx, 'p1', 'acc-1', {
        forUpdate: true,
      });

      expect(mockQueryBuilder.setLock).toHaveBeenCalledWith('pessimistic_write');
      expect(result).toEqual(passenger);
    });

    it('does not set lock when forUpdate is true but context is null', async () => {
      await repository.findByIdAndAccountId(null, 'p1', 'acc-1', {
        forUpdate: true,
      });

      expect(mockDataSource.getRepository).toHaveBeenCalledWith(PassengerEntity);
      expect(mockQueryBuilder.setLock).not.toHaveBeenCalled();
    });

    it('uses dataSource when context is null', async () => {
      await repository.findByIdAndAccountId(null, 'p1', 'acc-1');

      expect(mockDataSource.getRepository).toHaveBeenCalledWith(PassengerEntity);
      expect(mockQueryBuilder.where).toHaveBeenCalledWith('passenger.id = :id', { id: 'p1' });
      expect(mockQueryBuilder.andWhere).toHaveBeenCalledWith('passenger.account_id = :accountId', {
        accountId: 'acc-1',
      });
    });

    it('returns null when passenger is not found', async () => {
      (mockQueryBuilder.getOne as any).mockResolvedValue(null);

      const result = await repository.findByIdAndAccountId(null, 'p-missing', 'acc-1');
      expect(result).toBeNull();
    });
  });

  describe('delete', () => {
    it('deletes passenger by id with context', async () => {
      await repository.delete(mockCtx, 'p1');

      expect(mockEntityManager.delete).toHaveBeenCalledWith(PassengerEntity, { id: 'p1' });
    });

    it('deletes passenger using dataSource when context is null', async () => {
      await repository.delete(null as any, 'p1');

      expect(mockEntityRepository.delete).toHaveBeenCalledWith({ id: 'p1' });
    });
  });

  describe('countCompanionsByAccountId', () => {
    it('filters by accountId and isSelf: false with context', async () => {
      (mockEntityRepository.count as any).mockResolvedValue(3);

      const count = await repository.countCompanionsByAccountId(mockCtx, 'acc-1');

      expect(mockEntityManager.getRepository).toHaveBeenCalledWith(PassengerEntity);
      expect(mockEntityRepository.count).toHaveBeenCalledWith({
        where: {
          accountId: 'acc-1',
          isSelf: false,
        },
      });
      expect(count).toBe(3);
    });

    it('uses dataSource when context is null', async () => {
      (mockEntityRepository.count as any).mockResolvedValue(2);

      const count = await repository.countCompanionsByAccountId(null as any, 'acc-1');

      expect(mockDataSource.getRepository).toHaveBeenCalledWith(PassengerEntity);
      expect(mockEntityRepository.count).toHaveBeenCalledWith({
        where: {
          accountId: 'acc-1',
          isSelf: false,
        },
      });
      expect(count).toBe(2);
    });
  });
});

describe('BookingTicketCheckPort', () => {
  it('defines BOOKING_TICKET_CHECK symbol', () => {
    expect(typeof BOOKING_TICKET_CHECK).toBe('symbol');
    expect(BOOKING_TICKET_CHECK.toString()).toContain('BOOKING_TICKET_CHECK');
  });

  describe('StubBookingTicketCheckAdapter', () => {
    it('always returns false for hasIssuedTickets', async () => {
      const adapter = new StubBookingTicketCheckAdapter();
      const result = await adapter.hasIssuedTickets('29901011234567');
      expect(result).toBe(false);
    });
  });
});
