import { Column, CreateDateColumn, Entity, Index, PrimaryColumn } from 'typeorm';
import type { AllocationOutcome, AssignedSeat, SplitNoticePayload } from '@app/contracts';

export type BookingDraftStatus = 'PENDING' | 'CONFIRMED' | 'CANCELLED' | 'FAILED';

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

  @Column({ name: 'expires_at', type: 'timestamptz' })
  expiresAt!: Date;

  @Column({ type: 'jsonb', default: () => "'[]'" })
  legs!: BookingDraftLeg[];

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;
}
