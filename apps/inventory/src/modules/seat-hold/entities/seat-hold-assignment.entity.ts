import {
  Check,
  Column,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryColumn,
} from 'typeorm';
import type { Relation } from 'typeorm';
import type { AllocationOutcome } from '@app/contracts';

import { SeatHoldGroupEntity } from './seat-hold-group.entity.js';

/**
 * Durable allocation receipt: a seat snapshot that survives release, expiry,
 * and later seat-plan republication. It intentionally has no FK to trip_seat.
 */
@Entity('seat_hold_assignment')
@Index(
  'uq_seat_hold_assignment_passenger',
  ['holdId', 'passengerRef', 'tripId'],
  { unique: true },
)
@Index(
  'uq_seat_hold_assignment_seat',
  ['holdId', 'tripId', 'tripSeatId'],
  { unique: true },
)
@Check(
  'chk_seat_hold_assignment_outcome',
  `"outcome" IN ('SIDE_BY_SIDE', 'SAME_COACH', 'SPLIT')`,
)
export class SeatHoldAssignmentEntity {
  @PrimaryColumn('uuid')
  id!: string;

  @Column({ name: 'hold_id', type: 'uuid' })
  holdId!: string;

  @ManyToOne(() => SeatHoldGroupEntity, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'hold_id' })
  hold?: Relation<SeatHoldGroupEntity>;

  @Column({ name: 'passenger_ref', type: 'text' })
  passengerRef!: string;

  @Column({ name: 'passenger_key_version', type: 'integer' })
  passengerKeyVersion!: number;

  @Column({ name: 'trip_id', type: 'uuid' })
  tripId!: string;

  @Column({ name: 'trip_seat_id', type: 'uuid' })
  tripSeatId!: string;

  @Column({ name: 'travel_class_id', type: 'uuid' })
  travelClassId!: string;

  @Column({ name: 'coach_number', type: 'integer' })
  coachNumber!: number;

  @Column({ name: 'seat_number', type: 'text' })
  seatNumber!: string;

  @Column({ name: 'row_number', type: 'integer' })
  rowNumber!: number;

  @Column({ type: 'text', nullable: true })
  label!: string | null;

  @Column({ type: 'text' })
  outcome!: AllocationOutcome;

  @Column({ name: 'origin_station_id', type: 'uuid' })
  originStationId!: string;

  @Column({ name: 'destination_station_id', type: 'uuid' })
  destinationStationId!: string;

  @Column({ name: 'origin_position', type: 'integer' })
  originPosition!: number;

  @Column({ name: 'destination_position', type: 'integer' })
  destinationPosition!: number;

  @Column({ type: 'text' })
  segment!: string;

  @Column({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;
}
