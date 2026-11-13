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

  async findSelfByAccountId(accountId: string): Promise<PassengerEntity | null> {
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
}

