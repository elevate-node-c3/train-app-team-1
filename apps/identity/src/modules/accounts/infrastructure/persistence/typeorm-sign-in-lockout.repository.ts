import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import type { TransactionContext } from '@app/common/persistence/unit-of-work.port.js';
import { entityManagerOf } from '@app/common/persistence/typeorm-unit-of-work.js';
import { SignInLockout } from '../../domain/sign-in-lockout.js';
import type { SignInLockoutRepositoryPort } from '../../application/ports/sign-in-lockout.repository.port.js';
import { SignInLockoutOrmEntity } from './sign-in-lockout.orm-entity.js';

function normalize(email: string): string {
  return email.trim().toLowerCase();
}

function toDomain(row: SignInLockoutOrmEntity): SignInLockout {
  return new SignInLockout(
    row.email,
    row.failedCount,
    row.lockedUntil,
    row.updatedAt,
  );
}

function toRow(lockout: SignInLockout): SignInLockoutOrmEntity {
  const row = new SignInLockoutOrmEntity();
  row.email = normalize(lockout.email);
  row.failedCount = lockout.failedCount;
  row.lockedUntil = lockout.lockedUntil;
  row.updatedAt = lockout.updatedAt;
  return row;
}

/**
 * A row keyed by normalized email, with no foreign key to `account` on purpose:
 * failed attempts against an address that does not exist must still be counted.
 */
@Injectable()
export class TypeOrmSignInLockoutRepository
  implements SignInLockoutRepositoryPort
{
  constructor(private readonly dataSource: DataSource) {}

  async find(email: string): Promise<SignInLockout | null> {
    const row = await this.dataSource
      .getRepository(SignInLockoutOrmEntity)
      .findOne({ where: { email: normalize(email) } });
    return row ? toDomain(row) : null;
  }

  async findForUpdate(
    ctx: TransactionContext,
    email: string,
  ): Promise<SignInLockout | null> {
    const row = await entityManagerOf(ctx)
      .getRepository(SignInLockoutOrmEntity)
      .createQueryBuilder('lockout')
      .setLock('pessimistic_write')
      .where('lockout.email = :email', { email: normalize(email) })
      .getOne();
    return row ? toDomain(row) : null;
  }

  async save(
    ctx: TransactionContext,
    lockout: SignInLockout,
  ): Promise<void> {
    // Upsert: the first failure for an address creates the row, and a
    // concurrent sign-in cannot turn a counter update into a duplicate insert.
    await entityManagerOf(ctx)
      .getRepository(SignInLockoutOrmEntity)
      .upsert(toRow(lockout), { conflictPaths: ['email'] });
  }
}
