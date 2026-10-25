import { Column, Entity, PrimaryColumn } from 'typeorm';
import type { VerificationCodePurpose } from '@app/contracts';

@Entity('verification_code')
export class VerificationCodeOrmEntity {
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

  @Column({ name: 'max_attempts', type: 'integer', default: 5 })
  maxAttempts!: number;
}
