import type { Account } from '../../domain/account.js';
import type { AccountOrmEntity } from './account.orm-entity.js';

/**
 * Domain object in, row shape out. The port returns nothing, so there is no
 * reverse direction to get wrong; if a read method is added, its mapper must
 * construct an aggregate through a named factory rather than leaking the entity.
 */
export function toAccountRow(account: Account): Partial<AccountOrmEntity> {
  return {
    id: account.id,
    email: account.email,
    language: account.language,
    status: account.status,
    createdAt: account.createdAt,
  };
}
