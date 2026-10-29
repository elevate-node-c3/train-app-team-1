import { Column, Entity, PrimaryColumn } from 'typeorm';

@Entity('device_credential')
export class DeviceCredentialEntity {
  @PrimaryColumn('uuid')
  id!: string;

  @Column({ name: 'account_id', type: 'uuid' })
  accountId!: string;

  @Column({ name: 'session_id', type: 'uuid', nullable: true })
  sessionId!: string | null;

  @Column({ type: 'text' })
  kind!: 'pin';

  @Column({ name: 'credential_hash', type: 'text' })
  credentialHash!: string;

  @Column({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @Column({ name: 'revoked_at', type: 'timestamptz', nullable: true })
  revokedAt!: Date | null;
}
