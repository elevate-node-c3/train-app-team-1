import { Column, Entity, PrimaryColumn } from 'typeorm';
import type { AccountStatus } from '../../domain/account.js';
import type { EventLanguage, StaffRole } from '@app/contracts';

/**
 * The table shape, deliberately separate from the aggregate. The domain owns
 * behaviour; this class exists so TypeORM has something to map, and the mapper
 * is the only place that knows both.
 */
@Entity('account')
export class AccountOrmEntity {
  @PrimaryColumn('uuid')
  id!: string;

  @Column({ type: 'text' })
  email!: string;

  @Column({ type: 'text' })
  language!: EventLanguage;

  @Column({ type: 'text' })
  status!: AccountStatus;

  @Column({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @Column({ name: 'password_hash', type: 'text', nullable: true })
  passwordHash!: string | null;

  @Column({ name: 'password_updated_at', type: 'timestamptz', nullable: true })
  passwordUpdatedAt!: Date | null;

  @Column({ name: 'email_verified_at', type: 'timestamptz', nullable: true })
  emailVerifiedAt!: Date | null;

  @Column({ type: 'boolean', default: false })
  bookable!: boolean;

  @Column({ type: 'text', array: true, default: () => 'ARRAY[]::text[]' })
  roles!: StaffRole[];
}
