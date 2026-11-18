import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryColumn,
} from 'typeorm';
import type {
  AllocationOutcome,
  AssignedSeat,
  ErrorCode,
  HoldLegInput,
  HoldSnapshot,
  HoldState,
  ResolvedHoldPassenger,
  SplitNoticePayload,
} from '@app/contracts';

export type BookingDraftStatus =
  'PENDING' | 'CONFIRMED' | 'CANCELLED' | 'FAILED';

export interface BookingHoldIntent {
  legs: HoldLegInput[];
  passengerRefs: string[];
}

export interface BookingHoldFailure {
  code: ErrorCode;
  availableCount?: number;
  passengerRef?: string;
}

export interface BookingDraftLeg {
  holdId: string;
  tripId: string;
  travelClassId: string;
  originStationId?: string;
  destinationStationId?: string;
  allocationOutcome: AllocationOutcome;
  seats: string[];
  assignedSeats?: AssignedSeat[];
  splitNotice?: SplitNoticePayload | null;
  expiresAt?: string;
}

@Entity('booking_draft')
@Index('idx_booking_draft_user', ['userId'])
export class BookingDraftEntity {
  @PrimaryColumn('uuid')
  id!: string;

  @Column({ name: 'user_id', type: 'varchar' })
  userId!: string;

  @Column({
    type: 'varchar',
    length: 20,
    default: 'PENDING',
  })
  status!: BookingDraftStatus;

  @Column({ name: 'expires_at', type: 'timestamptz', nullable: true })
  expiresAt!: Date | null;

  @Column({ type: 'jsonb', default: () => "'[]'" })
  legs!: BookingDraftLeg[];

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  // Null on historical drafts; their executed migration and receipts stay intact.
  @Column({
    name: 'request_fingerprint',
    type: 'varchar',
    length: 64,
    nullable: true,
  })
  requestFingerprint!: string | null;

  @Column({ name: 'hold_intent', type: 'jsonb', nullable: true })
  holdIntent!: BookingHoldIntent | null;

  @Column({ name: 'passenger_snapshot', type: 'jsonb', nullable: true })
  passengerSnapshot!: ResolvedHoldPassenger[] | null;

  @Column({ name: 'hold_requested', type: 'boolean', default: false })
  holdRequested!: boolean;

  @Column({ name: 'release_requested', type: 'boolean', default: false })
  releaseRequested!: boolean;

  @Column({ name: 'hold_id', type: 'uuid', nullable: true })
  holdId!: string | null;

  @Column({ name: 'hold_state', type: 'varchar', length: 20, nullable: true })
  holdState!: HoldState | null;

  @Column({ name: 'hold_version', type: 'integer', default: 0 })
  holdVersion!: number;

  @Column({ name: 'hold_snapshot', type: 'jsonb', nullable: true })
  holdSnapshot!: HoldSnapshot | null;

  @Column({ name: 'hold_server_now', type: 'timestamptz', nullable: true })
  holdServerNow!: Date | null;

  @Column({ name: 'extension_used', type: 'boolean', default: false })
  extensionUsed!: boolean;

  @Column({ name: 'reconciliation_pending', type: 'boolean', default: false })
  reconciliationPending!: boolean;

  @Column({ name: 'hold_failure', type: 'jsonb', nullable: true })
  holdFailure!: BookingHoldFailure | null;
}
