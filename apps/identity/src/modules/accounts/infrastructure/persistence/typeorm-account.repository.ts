import { Injectable } from '@nestjs/common';
import type { TransactionContext } from '@app/common/persistence/unit-of-work.port.js';
import { entityManagerOf } from '@app/common/persistence/typeorm-unit-of-work.js';
import type { Account } from '../../domain/account.js';
import type { AccountRepositoryPort } from '../../application/ports/account.repository.port.js';
import { AccountOrmEntity } from './account.orm-entity.js';
import { toAccountRow } from './account.mapper.js';

/**
 * Takes no DataSource on purpose. The only way to obtain an EntityManager is
 * the caller's `TransactionContext`, so this adapter cannot accidentally commit
 * outside the sign-up transaction.
 */
@Injectable()
export class TypeOrmAccountRepository implements AccountRepositoryPort {
  async save(ctx: TransactionContext, account: Account): Promise<void> {
    await entityManagerOf(ctx).insert(AccountOrmEntity, toAccountRow(account));
  }
}
