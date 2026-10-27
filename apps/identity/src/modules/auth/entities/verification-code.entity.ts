import { Column, Entity, PrimaryColumn } from 'typeorm';
import type { VerificationCodePurpose } from '@app/contracts';

export const VERIFICATION_CODE_MAX_ATTEMPTS = 5;

/**
 * Only the hash and salt are persisted; the plaintext leaves the process once,
 * inside the event payload.
 */
@Entity('verification_code')
export class VerificationCodeEntity {
  @PrimaryColumn('uuid')
  id!: string;

  @Column({ name: 'account_id', type: 'uuid' })
  accountId!: string;

  @Column({ type: 'text' })
  purpose!: VerificationCodePurpose;

  @Column({ name: 'code_hash', type: 'text' })
  codeHash!: string;

  @Column({ name: 'code_salt', type: 'text' })
  codeSalt!: string;

  @Column({ name: 'issued_at', type: 'timestamptz' })
  issuedAt!: Date;

  @Column({ name: 'expires_at', type: 'timestamptz' })
  expiresAt!: Date;

  @Column({ name: 'consumed_at', type: 'timestamptz', nullable: true })
  consumedAt!: Date | null;

  @Column({ type: 'integer', default: 0 })
  attempts!: number;

  @Column({
    name: 'max_attempts',
    type: 'integer',
    default: VERIFICATION_CODE_MAX_ATTEMPTS,
  })
  maxAttempts!: number;
}
