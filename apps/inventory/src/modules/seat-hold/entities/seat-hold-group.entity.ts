import { Check, Column, Entity, Index, PrimaryColumn } from 'typeorm';
import type { HoldState } from '@app/contracts';

/**
 * One traveller's hold lifecycle head. A key row is immutable after first use:
 * replay returns its original allocation and a terminal state is never revived.
 *
 * The partial unique owner index is deliberate: an expired-but-unreleased head
 * still occupies it until the create/replacement or expiry path releases it.
 */
@Entity('seat_hold_group')
@Index('uq_seat_hold_group_booking_key', ['bookingKey'], { unique: true })
@Index('uq_seat_hold_group_owner_active', ['ownerId'], {
  unique: true,
  where: "state = 'held'",
})
@Index('idx_seat_hold_group_due', ['expiresAt'], {
  where: "state = 'held'",
})
@Check(
  'chk_seat_hold_group_state',
  `"state" IN ('held', 'released', 'expired', 'cancelled')`,
)
@Check('chk_seat_hold_group_version', `"version" > 0`)
@Check(
  'chk_seat_hold_group_held_expiry',
  `"state" <> 'held' OR "expires_at" IS NOT NULL`,
)
export class SeatHoldGroupEntity {
  @PrimaryColumn('uuid')
  id!: string;

  @Column({ name: 'booking_key', type: 'text' })
  bookingKey!: string;

  @Column({ name: 'owner_id', type: 'uuid' })
  ownerId!: string;

  /** Canonical owner/legs/passengers digest; changed payloads never rebind. */
  @Column({ name: 'request_fingerprint', type: 'text' })
  requestFingerprint!: string;

  @Column({ type: 'text' })
  state!: Lowercase<HoldState>;

  @Column({ type: 'integer' })
  version!: number;

  @Column({ name: 'extension_used', type: 'boolean' })
  extensionUsed!: boolean;

  @Column({ name: 'expires_at', type: 'timestamptz', nullable: true })
  expiresAt!: Date | null;

  @Column({ name: 'released_at', type: 'timestamptz', nullable: true })
  releasedAt!: Date | null;

  @Column({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @Column({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;
}
