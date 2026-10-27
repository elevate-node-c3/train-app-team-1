import { Column, Entity, PrimaryColumn } from 'typeorm';

/**
 * Keyed by normalized email, with no foreign key to `account` on purpose:
 * failed attempts against an address that does not exist must still count.
 */
@Entity('sign_in_lockout')
export class SignInLockoutEntity {
  @PrimaryColumn('text')
  email!: string;

  @Column({ name: 'failed_count', type: 'integer' })
  failedCount!: number;

  @Column({ name: 'locked_until', type: 'timestamptz', nullable: true })
  lockedUntil!: Date | null;

  @Column({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;
}
