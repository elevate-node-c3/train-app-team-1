import { Column, CreateDateColumn, Entity, PrimaryColumn } from 'typeorm';

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
}
