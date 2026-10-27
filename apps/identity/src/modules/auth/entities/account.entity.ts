import { Column, Entity, PrimaryColumn } from 'typeorm';
import type { EventLanguage, StaffRole } from '@app/contracts';

export type AccountStatus = 'pending' | 'active' | 'disabled';

@Entity('account')
export class AccountEntity {
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
