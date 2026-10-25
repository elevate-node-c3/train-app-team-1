import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import type { TransactionContext } from '@app/common/persistence/unit-of-work.port.js';
import { entityManagerOf } from '@app/common/persistence/typeorm-unit-of-work.js';
import type { Account } from '../../domain/account.js';
import type { AccountRepositoryPort } from '../../application/ports/account.repository.port.js';
import { AccountOrmEntity } from './account.orm-entity.js';
import { toAccountDomain, toAccountRow } from './account.mapper.js';

/**
 * Writes take the caller's `TransactionContext`; reads that do not need a lock
 * use the shared DataSource. The adapter cannot accidentally commit a write
 * outside the use-case's transaction.
 */
@Injectable()
export class TypeOrmAccountRepository implements AccountRepositoryPort {
  constructor(private readonly dataSource: DataSource) {}

  async save(ctx: TransactionContext, account: Account): Promise<void> {
    await entityManagerOf(ctx).insert(AccountOrmEntity, toAccountRow(account));
  }

  async update(ctx: TransactionContext, account: Account): Promise<void> {
    await entityManagerOf(ctx).update(
      AccountOrmEntity,
      { id: account.id },
      toAccountRow(account),
    );
  }

  async findByEmail(email: string): Promise<Account | null> {
    const row = await this.dataSource
      .getRepository(AccountOrmEntity)
      .createQueryBuilder('account')
      .where('lower(account.email) = :email', {
        email: email.trim().toLowerCase(),
      })
      .getOne();
    return row ? toAccountDomain(row) : null;
  }

  async findById(id: string): Promise<Account | null> {
    const row = await this.dataSource
      .getRepository(AccountOrmEntity)
      .findOne({ where: { id } });
    return row ? toAccountDomain(row) : null;
  }

  async findByEmailForUpdate(
    ctx: TransactionContext,
    email: string,
  ): Promise<Account | null> {
    const row = await entityManagerOf(ctx)
      .getRepository(AccountOrmEntity)
      .createQueryBuilder('account')
      .setLock('pessimistic_write')
      .where('lower(account.email) = :email', {
        email: email.trim().toLowerCase(),
      })
      .getOne();
    return row ? toAccountDomain(row) : null;
  }

  async findByIdForUpdate(
    ctx: TransactionContext,
    id: string,
  ): Promise<Account | null> {
    const row = await entityManagerOf(ctx)
      .getRepository(AccountOrmEntity)
      .createQueryBuilder('account')
      .setLock('pessimistic_write')
      .where('account.id = :id', { id })
      .getOne();
    return row ? toAccountDomain(row) : null;
  }
}
