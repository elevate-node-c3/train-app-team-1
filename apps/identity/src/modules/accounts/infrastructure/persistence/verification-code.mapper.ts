import { VerificationCode } from '../../domain/verification-code.js';
import type { VerificationCodeOrmEntity } from './verification-code.orm-entity.js';

/**
 * The row receives the hash and salt only. If this mapper ever grows a field
 * named `code`, the plaintext has leaked past the event payload.
 */
export function toVerificationCodeRow(
  code: VerificationCode,
): Partial<VerificationCodeOrmEntity> {
  return {
    id: code.id,
    accountId: code.accountId,
    purpose: code.purpose,
    codeHash: code.codeHash,
    codeSalt: code.codeSalt,
    issuedAt: code.issuedAt,
    expiresAt: code.expiresAt,
    consumedAt: code.consumedAt,
    attempts: code.attempts,
    maxAttempts: code.maxAttempts,
  };
}

export function toVerificationCodeDomain(
  row: VerificationCodeOrmEntity,
): VerificationCode {
  return VerificationCode.restore({
    id: row.id,
    accountId: row.accountId,
    purpose: row.purpose,
    codeHash: row.codeHash,
    codeSalt: row.codeSalt,
    issuedAt: row.issuedAt,
    expiresAt: row.expiresAt,
    consumedAt: row.consumedAt,
    attempts: row.attempts,
    maxAttempts: row.maxAttempts,
  });
}
