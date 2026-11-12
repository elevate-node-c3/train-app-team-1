import { Column, Entity, PrimaryColumn } from 'typeorm';

/** No account foreign key; count unknown normalized emails toward lockout too. */
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
