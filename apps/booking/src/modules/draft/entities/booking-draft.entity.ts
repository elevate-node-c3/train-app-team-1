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
  BookingLeg,
  ErrorCode,
  HoldLegInput,
  HoldSnapshot,
  HoldState,
  QuotedLeg,
  ResolvedHoldPassenger,
  SplitNoticePayload,
  TravelClass,
} from '@app/contracts';

export type BookingDraftStatus =
  'PENDING' | 'CONFIRMED' | 'CANCELLED' | 'FAILED';

/**
 * Where checkout has reached. Distinct from `status`, which is the draft's own
 * lifecycle, and from `holdState`, which mirrors inventory's hold.
 */
export type BookingFlowState =
  | 'quote_pending'
  | 'price_locked'
  | 'hold_pending'
  | 'seats_held'
  | 'payment_starting'
  | 'awaiting_payment'
  | 'expired'
  | 'abandoned'
  | 'failed'
  | 'confirming'
  | 'confirmed'
  | 'refunding'
  | 'refunded';

export type CompensationStatus = 'none' | 'pending' | 'complete' | 'late_payment';

/** Inventory's settlement outcome, lower-cased for this column's own check. */
export type SettlementOutcomeColumn = 'sold' | 'reallocated' | 'no_seats';

export interface SettledSeat {
  passengerRef: string;
  tripId: string;
  coachNumber: number;
  seatNumber: string;
}

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
  // ---------------------------------------------------------------------
  // Checkout flow. Null on drafts created before the flow existed, and on
  // drafts the hold API created directly.
  // ---------------------------------------------------------------------

  @Column({ name: 'flow_state', type: 'varchar', length: 32, nullable: true })
  flowState!: BookingFlowState | null;

  @Column({ name: 'idempotency_key', type: 'text', nullable: true })
  idempotencyKey!: string | null;

  @Column({ name: 'correlation_id', type: 'text', nullable: true })
  correlationId!: string | null;

  @Column({ name: 'travel_class', type: 'jsonb', nullable: true })
  travelClass!: TravelClass | null;

  @Column({ name: 'quoted_legs', type: 'jsonb', nullable: true })
  quotedLegs!: QuotedLeg[] | null;

  @Column({ name: 'fare_total_piastres', type: 'integer', nullable: true })
  fareTotalPiastres!: number | null;

  @Column({ name: 'booking_fee_piastres', type: 'integer', nullable: true })
  bookingFeePiastres!: number | null;

  @Column({ name: 'total_piastres', type: 'integer', nullable: true })
  totalPiastres!: number | null;

  @Column({ name: 'terms_accepted_at', type: 'timestamptz', nullable: true })
  termsAcceptedAt!: Date | null;

  @Column({ name: 'payment_reference', type: 'uuid', nullable: true })
  paymentReference!: string | null;

  @Column({ name: 'payment_attempted', type: 'boolean', default: false })
  paymentAttempted!: boolean;

  @Column({ name: 'late_payment', type: 'boolean', default: false })
  latePayment!: boolean;

  @Column({ name: 'charge_cancelled', type: 'boolean', default: false })
  chargeCancelled!: boolean;

  @Column({ name: 'hold_released', type: 'boolean', default: false })
  holdReleased!: boolean;

  @Column({
    name: 'compensation_status',
    type: 'varchar',
    length: 16,
    default: 'none',
  })
  compensationStatus!: CompensationStatus;

  @Column({ name: 'compensation_attempts', type: 'integer', default: 0 })
  compensationAttempts!: number;

  @Column({
    name: 'compensation_next_attempt_at',
    type: 'timestamptz',
    nullable: true,
  })
  compensationNextAttemptAt!: Date | null;

  @Column({ name: 'compensation_last_error', type: 'text', nullable: true })
  compensationLastError!: string | null;

  @Column({ name: 'resume_next_attempt_at', type: 'timestamptz', nullable: true })
  resumeNextAttemptAt!: Date | null;

  @Column({ name: 'resume_attempts', type: 'integer', default: 0 })
  resumeAttempts!: number;

  @Column({ name: 'lease_until', type: 'timestamptz', nullable: true })
  leaseUntil!: Date | null;

  @Column({ name: 'lease_owner', type: 'uuid', nullable: true })
  leaseOwner!: string | null;

  @Column({ name: 'updated_at', type: 'timestamptz', default: () => 'now()' })
  updatedAt!: Date;

  // ---------------------------------------------------------------------
  // TA-107 confirmation saga.
  // ---------------------------------------------------------------------

  @Column({ name: 'payment_succeeded_at', type: 'timestamptz', nullable: true })
  paymentSucceededAt!: Date | null;

  @Column({ name: 'payment_event_id', type: 'uuid', nullable: true })
  paymentEventId!: string | null;

  @Column({
    name: 'settlement_outcome',
    type: 'varchar',
    length: 16,
    nullable: true,
  })
  settlementOutcome!: SettlementOutcomeColumn | null;

  @Column({ name: 'settled_seats', type: 'jsonb', nullable: true })
  settledSeats!: SettledSeat[] | null;

  @Column({ name: 'seats_changed', type: 'boolean', default: false })
  seatsChanged!: boolean;

  @Column({ name: 'tickets_issued_at', type: 'timestamptz', nullable: true })
  ticketsIssuedAt!: Date | null;

  @Column({ name: 'refund_reference', type: 'text', nullable: true })
  refundReference!: string | null;

  @Column({ name: 'refunded_at', type: 'timestamptz', nullable: true })
  refundedAt!: Date | null;

  @Column({ name: 'saga_step', type: 'varchar', length: 24, nullable: true })
  sagaStep!: string | null;

  /** How many passengers the hold is for; the intent is the source. */
  get passengerCount(): number {
    return this.holdIntent?.passengerRefs.length ?? 0;
  }

  /** One class per booking, as submitted on every leg. */
  get travelClassId(): string | null {
    return this.holdIntent?.legs[0]?.travelClassId ?? null;
  }

  /** The legs as submitted; holdIntent carries the same trips for the hold. */
  get bookingLegs(): BookingLeg[] {
    return (this.holdIntent?.legs ?? []).map((leg) => ({
      tripId: leg.tripId,
      originStationId: leg.originStationId,
      destinationStationId: leg.destinationStationId,
    }));
  }
}
