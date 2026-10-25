import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import type { VerificationCodePurpose } from '@app/contracts';
import type { TransactionContext } from '@app/common/persistence/unit-of-work.port.js';
import { entityManagerOf } from '@app/common/persistence/typeorm-unit-of-work.js';
import { VerificationRequest } from '../../domain/verification-request.js';
import type { VerificationRequestRepositoryPort } from '../../application/ports/verification-request.repository.port.js';
import { VerificationRequestOrmEntity } from './verification-request.orm-entity.js';

function normalize(email: string): string {
  return email.trim().toLowerCase();
}

/**
 * Every issuance is recorded, including one for an address with no account.
 * The counter is what makes "is this address registered?" expensive to ask.
 */
@Injectable()
export class TypeOrmVerificationRequestRepository
  implements VerificationRequestRepositoryPort
{
  constructor(private readonly dataSource: DataSource) {}

  async record(
    ctx: TransactionContext,
    request: VerificationRequest,
  ): Promise<void> {
    await entityManagerOf(ctx).insert(VerificationRequestOrmEntity, {
      id: request.id,
      email: normalize(request.email),
      accountId: request.accountId,
      purpose: request.purpose,
      issuedAt: request.issuedAt,
    });
  }

  async latestForEmail(
    email: string,
    purpose: VerificationCodePurpose,
  ): Promise<VerificationRequest | null> {
    const row = await this.dataSource
      .getRepository(VerificationRequestOrmEntity)
      .createQueryBuilder('request')
      .where('request.email = :email', { email: normalize(email) })
      .andWhere('request.purpose = :purpose', { purpose })
      .orderBy('request.issuedAt', 'DESC')
      .limit(1)
      .getOne();

    return row ? toDomain(row) : null;
  }

  async countSince(
    email: string,
    purpose: VerificationCodePurpose,
    since: Date,
  ): Promise<number> {
    return this.dataSource
      .getRepository(VerificationRequestOrmEntity)
      .createQueryBuilder('request')
      .where('request.email = :email', { email: normalize(email) })
      .andWhere('request.purpose = :purpose', { purpose })
      .andWhere('request.issuedAt >= :since', { since })
      .getCount();
  }
}

function toDomain(row: VerificationRequestOrmEntity): VerificationRequest {
  return new VerificationRequest(
    row.id,
    row.email,
    row.accountId,
    row.purpose,
    row.issuedAt,
  );
}
