import { Column, Entity, PrimaryColumn } from 'typeorm';
import type { VerificationCodePurpose } from '@app/contracts';
import type { EmailDeliveryOutcome } from '../email-delivery.types.js';

/**
 * The append-only delivery measurement. The nullable columns are meaningful
 * only in combination with `outcome`; the repository's union-to-row mapping and
 * the database CHECK keep them consistent.
 */
@Entity('email_delivery')
export class EmailDeliveryEntity {
  @PrimaryColumn('uuid')
  id!: string;

  @Column({ name: 'event_id', type: 'uuid' })
  eventId!: string;

  @Column({ name: 'account_id', type: 'uuid' })
  accountId!: string;

  @Column({ name: 'recipient_email', type: 'text' })
  recipientEmail!: string;

  @Column({ type: 'text' })
  purpose!: VerificationCodePurpose;

  @Column({ type: 'text' })
  outcome!: EmailDeliveryOutcome;

  @Column({ name: 'skip_reason', type: 'text', nullable: true })
  skipReason!: string | null;

  @Column({ name: 'issued_at', type: 'timestamptz' })
  issuedAt!: Date;

  @Column({ name: 'accepted_at', type: 'timestamptz', nullable: true })
  acceptedAt!: Date | null;

  @Column({ name: 'latency_ms', type: 'integer', nullable: true })
  latencyMs!: number | null;

  @Column({ name: 'error_message', type: 'text', nullable: true })
  errorMessage!: string | null;

  @Column({ name: 'created_at', type: 'timestamptz', default: () => 'now()' })
  createdAt!: Date;
}
