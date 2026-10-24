import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { ensureDataSourceInitialized } from '@app/common';
import { CodePurpose, MAX_CODE_ATTEMPTS } from '../domain/one-time-code.js';
import { AccountEntity } from './entities/account.entity.js';
import { OneTimeCodeEntity } from './entities/one-time-code.entity.js';

/**
 * Codes live in Postgres, not Redis, so that using a code and applying the
 * change it authorizes commit together, exactly once.
 */
@Injectable()
export class OneTimeCodeRepository {
  constructor(private readonly dataSource: DataSource) {}

  /**
   * Stores a new code hash, replacing (and so invalidating) any earlier code.
   * @returns resolves once stored
   */
  async replace(
    accountId: string,
    purpose: CodePurpose,
    codeHash: string,
    expiresAt: Date,
  ): Promise<void> {
    await ensureDataSourceInitialized(this.dataSource);
    await this.dataSource.getRepository(OneTimeCodeEntity).upsert(
      {
        accountId,
        purpose,
        codeHash,
        expiresAt,
        attempts: 0,
        consumedAt: null,
      },
      ['accountId', 'purpose'],
    );
  }

  /**
   * Finds the account's code that is unused, unexpired and has attempts left.
   * @returns the code, or null if there is none
   */
  async findUsable(
    accountId: string,
    purpose: CodePurpose,
  ): Promise<OneTimeCodeEntity | null> {
    await ensureDataSourceInitialized(this.dataSource);
    return this.dataSource
      .getRepository(OneTimeCodeEntity)
      .createQueryBuilder('code')
      .where('code.accountId = :accountId', { accountId })
      .andWhere('code.purpose = :purpose', { purpose })
      .andWhere('code.consumedAt IS NULL')
      .andWhere('code.expiresAt > now()')
      .andWhere('code.attempts < :max', { max: MAX_CODE_ATTEMPTS })
      .getOne();
  }

  /**
   * Counts a wrong guess with one atomic increment.
   * @returns resolves once counted
   */
  async recordFailedAttempt(codeId: string): Promise<void> {
    await ensureDataSourceInitialized(this.dataSource);
    await this.dataSource
      .getRepository(OneTimeCodeEntity)
      .increment({ id: codeId }, 'attempts', 1);
  }

  /**
   * In one transaction, uses up the code (only if still valid) and saves the
   * new password.
   * @returns true if this call used the code; false if it was already used or expired
   */
  async consumeForPasswordReset(
    code: OneTimeCodeEntity,
    passwordHash: string,
    passwordChangedAt: Date,
  ): Promise<boolean> {
    await ensureDataSourceInitialized(this.dataSource);
    return this.dataSource.transaction(async (manager) => {
      const consumed = await manager
        .createQueryBuilder()
        .update(OneTimeCodeEntity)
        .set({ consumedAt: () => 'now()' })
        .where('id = :id', { id: code.id })
        .andWhere('code_hash = :codeHash', { codeHash: code.codeHash })
        .andWhere('consumed_at IS NULL')
        .andWhere('expires_at > now()')
        .andWhere('attempts < :max', { max: MAX_CODE_ATTEMPTS })
        .execute();
      if (consumed.affected !== 1) {
        return false;
      }

      await manager
        .createQueryBuilder()
        .update(AccountEntity)
        .set({
          passwordHash,
          passwordChangedAt,
          // Receiving the code proves the email, so a reset also verifies it.
          verifiedAt: () => 'COALESCE(verified_at, now())',
        })
        .where('id = :id', { id: code.accountId })
        .execute();
      return true;
    });
  }
}
