import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import type { TransactionContext } from '@app/common/persistence/unit-of-work.port.js';
import { entityManagerOf } from '@app/common/persistence/typeorm-unit-of-work.js';
import { SignInLockoutEntity } from '../entities/sign-in-lockout.entity.js';

function normalize(email: string): string {
  return email.trim().toLowerCase();
}

/**
 * A row keyed by normalized email, with no foreign key to `account` on purpose:
 * failed attempts against an address that does not exist must still be counted.
 */
@Injectable()
export class SignInLockoutRepository {
  constructor(private readonly dataSource: DataSource) {}

  async find(email: string): Promise<SignInLockoutEntity | null> {
    return this.dataSource
      .getRepository(SignInLockoutEntity)
      .findOne({ where: { email: normalize(email) } });
  }

  async findForUpdate(
    ctx: TransactionContext,
    email: string,
  ): Promise<SignInLockoutEntity | null> {
    return entityManagerOf(ctx)
      .getRepository(SignInLockoutEntity)
      .createQueryBuilder('lockout')
      .setLock('pessimistic_write')
      .where('lockout.email = :email', { email: normalize(email) })
      .getOne();
  }

  async save(
    ctx: TransactionContext,
    lockout: SignInLockoutEntity,
  ): Promise<void> {
    // Upsert: the first failure for an address creates the row, and a
    // concurrent sign-in cannot turn a counter update into a duplicate insert.
    await entityManagerOf(ctx)
      .getRepository(SignInLockoutEntity)
      .upsert(
        {
          email: normalize(lockout.email),
          failedCount: lockout.failedCount,
          lockedUntil: lockout.lockedUntil,
          updatedAt: lockout.updatedAt,
        },
        { conflictPaths: ['email'] },
      );
  }
}
