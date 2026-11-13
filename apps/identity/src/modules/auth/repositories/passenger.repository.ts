import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import type { TransactionContext } from '@app/common/persistence/unit-of-work.port.js';
import { entityManagerOf } from '@app/common/persistence/typeorm-unit-of-work.js';
import { PassengerEntity } from '../entities/passenger.entity.js';

@Injectable()
export class PassengerRepository {
  constructor(private readonly dataSource: DataSource) {}

  async save(
    ctx: TransactionContext,
    passenger: PassengerEntity,
  ): Promise<void> {
    await entityManagerOf(ctx).insert(PassengerEntity, passenger);
  }

  async update(
    ctx: TransactionContext,
    passenger: PassengerEntity,
  ): Promise<void> {
    await entityManagerOf(ctx).update(
      PassengerEntity,
      { id: passenger.id },
      passenger,
    );
  }

  async findByAccountAndNationalId(
    ctx: TransactionContext,
    accountId: string,
    nationalId: string,
  ): Promise<PassengerEntity | null> {
    return entityManagerOf(ctx)
      .getRepository(PassengerEntity)
      .createQueryBuilder('passenger')
      .where('passenger.account_id = :accountId', { accountId })
      .andWhere('passenger.national_id = :nationalId', { nationalId })
      .getOne();
  }

  async findSelfByAccountId(
    accountId: string,
  ): Promise<PassengerEntity | null> {
    return this.dataSource
      .getRepository(PassengerEntity)
      .createQueryBuilder('passenger')
      .where('passenger.account_id = :accountId', { accountId })
      .andWhere('passenger.is_self = true')
      .getOne();
  }

  async countByAccountId(
    ctx: TransactionContext,
    accountId: string,
  ): Promise<number> {
    return entityManagerOf(ctx)
      .getRepository(PassengerEntity)
      .count({ where: { accountId } });
  }

  async findAllByAccountId(
    ctx: TransactionContext | null,
    accountId: string,
  ): Promise<PassengerEntity[]> {
    const repo = ctx
      ? entityManagerOf(ctx).getRepository(PassengerEntity)
      : this.dataSource.getRepository(PassengerEntity);
    return repo
      .createQueryBuilder('passenger')
      .where('passenger.account_id = :accountId', { accountId })
      .orderBy('passenger.is_self', 'DESC')
      .addOrderBy('passenger.created_at', 'ASC')
      .getMany();
  }

  async findByIdAndAccountId(
    ctx: TransactionContext | null,
    id: string,
    accountId: string,
    options?: { forUpdate?: boolean },
  ): Promise<PassengerEntity | null> {
    const repo = ctx
      ? entityManagerOf(ctx).getRepository(PassengerEntity)
      : this.dataSource.getRepository(PassengerEntity);
    const query = repo
      .createQueryBuilder('passenger')
      .where('passenger.id = :id', { id })
      .andWhere('passenger.account_id = :accountId', { accountId });

    if (options?.forUpdate && ctx) {
      query.setLock('pessimistic_write');
    }

    return query.getOne();
  }

  async delete(ctx: TransactionContext | null, id: string): Promise<void> {
    if (ctx) {
      await entityManagerOf(ctx).delete(PassengerEntity, { id });
    } else {
      await this.dataSource.getRepository(PassengerEntity).delete({ id });
    }
  }

  async countCompanionsByAccountId(
    ctx: TransactionContext | null,
    accountId: string,
  ): Promise<number> {
    const repo = ctx
      ? entityManagerOf(ctx).getRepository(PassengerEntity)
      : this.dataSource.getRepository(PassengerEntity);
    return repo.count({
      where: {
        accountId,
        isSelf: false,
      },
    });
  }
}
