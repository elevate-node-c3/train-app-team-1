import { Column, Entity, PrimaryColumn } from 'typeorm';
import type { VerificationCodePurpose } from '@app/contracts';

@Entity('verification_code_request')
export class VerificationRequestOrmEntity {
  @PrimaryColumn('uuid')
  id!: string;

  @Column({ type: 'text' })
  email!: string;

  @Column({ name: 'account_id', type: 'uuid', nullable: true })
  accountId!: string | null;

  @Column({ type: 'text' })
  purpose!: VerificationCodePurpose;

  @Column({ name: 'issued_at', type: 'timestamptz' })
  issuedAt!: Date;
}
