import { Column, Entity, PrimaryColumn } from 'typeorm';

@Entity('session')
export class SessionOrmEntity {
  @PrimaryColumn('uuid')
  id!: string;

  @Column({ name: 'account_id', type: 'uuid' })
  accountId!: string;

  @Column({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @Column({ name: 'last_used_at', type: 'timestamptz' })
  lastUsedAt!: Date;

  @Column({ name: 'expires_at', type: 'timestamptz' })
  expiresAt!: Date;

  @Column({ name: 'revoked_at', type: 'timestamptz', nullable: true })
  revokedAt!: Date | null;

  @Column({ name: 'revoked_reason', type: 'text', nullable: true })
  revokedReason!: string | null;

  @Column({ name: 'reuse_detected_at', type: 'timestamptz', nullable: true })
  reuseDetectedAt!: Date | null;
}
