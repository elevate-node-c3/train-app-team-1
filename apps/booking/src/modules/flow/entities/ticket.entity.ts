import { Column, CreateDateColumn, Entity, PrimaryColumn } from 'typeorm';
import type {
  LocalizedName,
  TicketStatus,
  TravelClass,
  TripEndpoint,
} from '@app/contracts';

/**
 * What the ticket prints, copied once at issuance (TA-108). Never rebuilt from
 * the live passenger, timetable or train: a rename, a republished timetable or
 * a changed train leaves an issued ticket exactly as it was.
 */
export interface TicketSnapshot {
  /** Short and read aloud; every ticket of one booking shares it. */
  bookingCode: string;
  passengerName: string;
  /**
   * Identity gives booking only the masked National ID, never the number, and
   * its last four digits are all a ticket or a QR may carry.
   */
  nationalIdLast4: string;
  trainNumber: number;
  trainType: LocalizedName;
  /** Plain words in both languages (BR-22). */
  travelClass: TravelClass;
  /** The passenger's own boarding station, with its Cairo date and time. */
  boarding: TripEndpoint;
  alighting: TripEndpoint;
  durationMinutes: number;
  /** This passenger on this leg, locked at the quote (BR-30). */
  farePiastres: number;
}

/**
 * One ticket per passenger per leg, issued only once the confirmation saga
 * sells inventory's seats. `ticketNumber` is the traveller-facing receipt;
 * the unique pair below is what makes a replayed confirm step a no-op.
 */
@Entity('ticket')
export class TicketEntity {
  @PrimaryColumn('uuid')
  id!: string;

  @Column({ name: 'booking_reference', type: 'uuid' })
  bookingReference!: string;

  @Column({ name: 'passenger_ref', type: 'text' })
  passengerRef!: string;

  @Column({ name: 'trip_id', type: 'uuid' })
  tripId!: string;

  @Column({ name: 'ticket_number', type: 'text', unique: true })
  ticketNumber!: string;

  @Column({ name: 'coach_number', type: 'integer' })
  coachNumber!: number;

  @Column({ name: 'seat_number', type: 'text' })
  seatNumber!: string;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  // -------------------------------------------------------------------------
  // TA-108: the issued snapshot and the ticket's own state. Null only on rows
  // issued before the snapshot existed.
  // -------------------------------------------------------------------------

  /** The booking's owner, so a traveller's list needs no join. */
  @Column({ name: 'owner_id', type: 'varchar', nullable: true })
  ownerId!: string | null;

  @Column({ type: 'jsonb', nullable: true })
  snapshot!: TicketSnapshot | null;

  /** Boarding at the passenger's own station: the list's sort key. */
  @Column({ name: 'departs_at', type: 'timestamptz', nullable: true })
  departsAt!: Date | null;

  /** Arrival at the passenger's own station: when a share link expires. */
  @Column({ name: 'arrives_at', type: 'timestamptz', nullable: true })
  arrivesAt!: Date | null;

  /** Signed once at issuance and printed verbatim (BR-38). */
  @Column({ name: 'qr_payload', type: 'text', nullable: true })
  qrPayload!: string | null;

  /** Moved by cancellation (BOOK-4) and voiding; never by this module. */
  @Column({ type: 'varchar', length: 16, default: 'active' })
  status!: TicketStatus;

  @Column({ name: 'status_reason', type: 'text', nullable: true })
  statusReason!: string | null;

  @Column({ name: 'status_changed_at', type: 'timestamptz', nullable: true })
  statusChangedAt!: Date | null;
}
