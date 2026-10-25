import { Account } from '../../domain/account.js';
import type { AccountOrmEntity } from './account.orm-entity.js';

/** Domain object in, row shape out. */
export function toAccountRow(account: Account): Partial<AccountOrmEntity> {
  return {
    id: account.id,
    email: account.email,
    language: account.language,
    status: account.status,
    createdAt: account.createdAt,
    passwordHash: account.passwordHash,
    passwordUpdatedAt: account.passwordUpdatedAt,
    emailVerifiedAt: account.emailVerifiedAt,
    bookable: account.bookable,
    roles: account.roles,
  };
}

/** Row in, aggregate out. The only place that knows both shapes. */
export function toAccountDomain(row: AccountOrmEntity): Account {
  return Account.restore({
    id: row.id,
    email: row.email,
    language: row.language,
    status: row.status,
    createdAt: row.createdAt,
    passwordHash: row.passwordHash,
    passwordUpdatedAt: row.passwordUpdatedAt,
    emailVerifiedAt: row.emailVerifiedAt,
    bookable: row.bookable,
    roles: row.roles,
  });
}
