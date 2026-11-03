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

  @Column({ name: 'full_name', type: 'text', nullable: true })
  fullName!: string | null;

  @Column({ name: 'phone_number', type: 'text', nullable: true })
  phoneNumber!: string | null;

  @Column({ name: 'national_id', type: 'text', nullable: true })
  nationalId!: string | null;

  @Column({ name: 'profile_type', type: 'text', nullable: true })
  profileType!: string | null;

  @Column({ type: 'text', nullable: true })
  nationality!: string | null;

  @Column({ name: 'profile_completed_at', type: 'timestamptz', nullable: true })
  profileCompletedAt!: Date | null;
}
