import { Injectable } from '@nestjs/common';
import type { VerificationCodePurpose } from '@app/contracts';
import type { TransactionContext } from '@app/common/persistence/unit-of-work.port.js';
import { entityManagerOf } from '@app/common/persistence/typeorm-unit-of-work.js';
import type { VerificationCode } from '../../domain/verification-code.js';
import type { VerificationCodeRepositoryPort } from '../../application/ports/verification-code.repository.port.js';
import { VerificationCodeOrmEntity } from './verification-code.orm-entity.js';
import {
  toVerificationCodeDomain,
  toVerificationCodeRow,
} from './verification-code.mapper.js';

@Injectable()
export class TypeOrmVerificationCodeRepository
  implements VerificationCodeRepositoryPort
{
  async save(
    ctx: TransactionContext,
    code: VerificationCode,
  ): Promise<void> {
    await entityManagerOf(ctx).insert(
      VerificationCodeOrmEntity,
      toVerificationCodeRow(code),
    );
  }

  async update(
    ctx: TransactionContext,
    code: VerificationCode,
  ): Promise<void> {
    await entityManagerOf(ctx).update(
      VerificationCodeOrmEntity,
      { id: code.id },
      toVerificationCodeRow(code),
    );
  }

  async findLatestLive(
    ctx: TransactionContext,
    accountId: string,
    purpose: VerificationCodePurpose,
    options: { forUpdate?: boolean } = {},
  ): Promise<VerificationCode | null> {
    const query = entityManagerOf(ctx)
      .getRepository(VerificationCodeOrmEntity)
      .createQueryBuilder('code')
      .where('code.accountId = :accountId', { accountId })
      .andWhere('code.purpose = :purpose', { purpose })
      .andWhere('code.consumedAt IS NULL')
      .orderBy('code.issuedAt', 'DESC')
      .limit(1);

    if (options.forUpdate) query.setLock('pessimistic_write');
    const row = await query.getOne();
    return row ? toVerificationCodeDomain(row) : null;
  }

  async consumeLive(
    ctx: TransactionContext,
    accountId: string,
    purposes: VerificationCodePurpose[],
    at: Date,
  ): Promise<void> {
    if (purposes.length === 0) return;
    await entityManagerOf(ctx)
      .getRepository(VerificationCodeOrmEntity)
      .createQueryBuilder()
      .update(VerificationCodeOrmEntity)
      .set({ consumedAt: at })
      .where('account_id = :accountId', { accountId })
      .andWhere('purpose IN (:...purposes)', { purposes })
      .andWhere('consumed_at IS NULL')
      .execute();
  }
}
