import { Injectable } from '@nestjs/common';
import type { VerificationCodePurpose } from '@app/contracts';
import type { TransactionContext } from '@app/common/persistence/unit-of-work.port.js';
import { entityManagerOf } from '@app/common/persistence/typeorm-unit-of-work.js';
import { VerificationCodeEntity } from '../entities/verification-code.entity.js';

/**
 * Only the hash and salt cross this boundary. The plaintext code reaches the
 * outbox inside the event payload and is never persisted by identity.
 */
@Injectable()
export class VerificationCodeRepository {
  async save(
    ctx: TransactionContext,
    code: VerificationCodeEntity,
  ): Promise<void> {
    await entityManagerOf(ctx).insert(VerificationCodeEntity, code);
  }

  async update(
    ctx: TransactionContext,
    code: VerificationCodeEntity,
  ): Promise<void> {
    await entityManagerOf(ctx).update(
      VerificationCodeEntity,
      { id: code.id },
      code,
    );
  }

  async findLatestLive(
    ctx: TransactionContext,
    accountId: string,
    purpose: VerificationCodePurpose,
    options: { forUpdate?: boolean } = {},
  ): Promise<VerificationCodeEntity | null> {
    const query = entityManagerOf(ctx)
      .getRepository(VerificationCodeEntity)
      .createQueryBuilder('code')
      .where('code.accountId = :accountId', { accountId })
      .andWhere('code.purpose = :purpose', { purpose })
      .andWhere('code.consumedAt IS NULL')
      .orderBy('code.issuedAt', 'DESC')
      .limit(1);

    if (options.forUpdate) query.setLock('pessimistic_write');
    return query.getOne();
  }

  async consumeLive(
    ctx: TransactionContext,
    accountId: string,
    purposes: VerificationCodePurpose[],
    at: Date,
  ): Promise<void> {
    if (purposes.length === 0) return;
    await entityManagerOf(ctx)
      .getRepository(VerificationCodeEntity)
      .createQueryBuilder()
      .update(VerificationCodeEntity)
      .set({ consumedAt: at })
      .where('account_id = :accountId', { accountId })
      .andWhere('purpose IN (:...purposes)', { purposes })
      .andWhere('consumed_at IS NULL')
      .execute();
  }
}
