import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import type { TransactionContext } from '@app/common/persistence/unit-of-work.port.js';
import { entityManagerOf } from '@app/common/persistence/typeorm-unit-of-work.js';
import { AccountEntity } from '../entities/account.entity.js';

/**
 * Writes take the caller's `TransactionContext`; reads that do not need a lock
 * use the shared DataSource. The repository cannot accidentally commit a write
 * outside the service's transaction.
 */
@Injectable()
export class AccountRepository {
  constructor(private readonly dataSource: DataSource) {}

  async save(ctx: TransactionContext, account: AccountEntity): Promise<void> {
    await entityManagerOf(ctx).insert(AccountEntity, account);
  }

  async update(ctx: TransactionContext, account: AccountEntity): Promise<void> {
    await entityManagerOf(ctx).update(
      AccountEntity,
      { id: account.id },
      account,
    );
  }

  async findByEmail(email: string): Promise<AccountEntity | null> {
    return this.dataSource
      .getRepository(AccountEntity)
      .createQueryBuilder('account')
      .where('lower(account.email) = :email', {
        email: email.trim().toLowerCase(),
      })
      .getOne();
  }

  async findById(id: string): Promise<AccountEntity | null> {
    return this.dataSource
      .getRepository(AccountEntity)
      .findOne({ where: { id } });
  }

  async findByEmailForUpdate(
    ctx: TransactionContext,
    email: string,
  ): Promise<AccountEntity | null> {
    return entityManagerOf(ctx)
      .getRepository(AccountEntity)
      .createQueryBuilder('account')
      .setLock('pessimistic_write')
      .where('lower(account.email) = :email', {
        email: email.trim().toLowerCase(),
      })
      .getOne();
  }

  async findByIdForUpdate(
    ctx: TransactionContext,
    id: string,
  ): Promise<AccountEntity | null> {
    return entityManagerOf(ctx)
      .getRepository(AccountEntity)
      .createQueryBuilder('account')
      .setLock('pessimistic_write')
      .where('account.id = :id', { id })
      .getOne();
  }
}
