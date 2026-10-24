import { Injectable } from '@nestjs/common';
import type { TransactionContext } from '@app/common/persistence/unit-of-work.port.js';
import { entityManagerOf } from '@app/common/persistence/typeorm-unit-of-work.js';
import type { VerificationCode } from '../../domain/verification-code.js';
import type { VerificationCodeRepositoryPort } from '../../application/ports/verification-code.repository.port.js';
import { VerificationCodeOrmEntity } from './verification-code.orm-entity.js';
import { toVerificationCodeRow } from './verification-code.mapper.js';

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
}
