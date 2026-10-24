import { Column, Entity, PrimaryGeneratedColumn, Unique } from 'typeorm';
import type { CodePurpose } from '../../domain/one-time-code.js';

/**
 * One live code per account and purpose: issuing a new code overwrites the
 * row, which invalidates the old one. Only the code's HMAC is stored.
 */
@Entity({ name: 'one_time_codes' })
@Unique(['accountId', 'purpose'])
export class OneTimeCodeEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'account_id', type: 'uuid' })
  accountId: string;

  @Column({ type: 'varchar', length: 32 })
  purpose: CodePurpose;

  @Column({ name: 'code_hash', type: 'char', length: 64 })
  codeHash: string;

  @Column({ type: 'integer', default: 0 })
  attempts: number;

  @Column({ name: 'expires_at', type: 'timestamptz' })
  expiresAt: Date;

  @Column({ name: 'consumed_at', type: 'timestamptz', nullable: true })
  consumedAt: Date | null;
}
