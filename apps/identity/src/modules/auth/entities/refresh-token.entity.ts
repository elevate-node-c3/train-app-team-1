import { Column, Entity, PrimaryColumn } from 'typeorm';

export type RefreshTokenStatus = 'active' | 'rotated' | 'revoked';

/**
 * A refresh token row stores only a hash. The successor pair is kept encrypted
 * for the grace window, never as a usable plaintext token in the table.
 */
@Entity('refresh_token')
export class RefreshTokenEntity {
  @PrimaryColumn('uuid')
  id!: string;

  @Column({ name: 'session_id', type: 'uuid' })
  sessionId!: string;

  @Column({ name: 'token_hash', type: 'text' })
  tokenHash!: string;

  @Column({ type: 'text' })
  status!: RefreshTokenStatus;

  @Column({ name: 'issued_at', type: 'timestamptz' })
  issuedAt!: Date;

  @Column({ name: 'expires_at', type: 'timestamptz' })
  expiresAt!: Date;

  @Column({ name: 'rotated_at', type: 'timestamptz', nullable: true })
  rotatedAt!: Date | null;

  @Column({ name: 'replaced_by_id', type: 'uuid', nullable: true })
  replacedById!: string | null;

  @Column({ name: 'grace_payload', type: 'text', nullable: true })
  gracePayload!: string | null;

  @Column({ name: 'grace_expires_at', type: 'timestamptz', nullable: true })
  graceExpiresAt!: Date | null;

  @Column({ name: 'revoked_at', type: 'timestamptz', nullable: true })
  revokedAt!: Date | null;
}
