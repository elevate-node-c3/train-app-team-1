import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import type { TransactionContext } from '@app/common/persistence/unit-of-work.port.js';
import { entityManagerOf } from '@app/common/persistence/typeorm-unit-of-work.js';
import { SignInLockoutEntity } from '../entities/sign-in-lockout.entity.js';

function normalize(email: string): string {
  return email.trim().toLowerCase();
}

/** Count failures by normalized email, including unknown accounts. */
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
    // Upsert prevents duplicate rows on concurrent first failures.
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
