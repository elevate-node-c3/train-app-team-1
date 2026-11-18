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

/** One leg's resolved inventory facts and SEAT-2 outcome. */
@Entity('seat_hold_leg')
@Index('uq_seat_hold_leg_trip', ['holdId', 'tripId'], { unique: true })
@Check(
  'chk_seat_hold_leg_segment',
  `NOT isempty("segment") AND lower("segment") >= 0`,
)
@Check(
  'chk_seat_hold_leg_outcome',
  `"outcome" IN ('SIDE_BY_SIDE', 'SAME_COACH', 'SPLIT')`,
)
export class SeatHoldLegEntity {
  @PrimaryColumn('uuid')
  id!: string;

  @Column({ name: 'hold_id', type: 'uuid' })
  holdId!: string;

  @ManyToOne(() => SeatHoldGroupEntity, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'hold_id' })
  hold?: Relation<SeatHoldGroupEntity>;

  @Column({ name: 'trip_id', type: 'uuid' })
  tripId!: string;

  @Column({ name: 'travel_class_id', type: 'uuid' })
  travelClassId!: string;

  @Column({ name: 'origin_station_id', type: 'uuid' })
  originStationId!: string;

  @Column({ name: 'destination_station_id', type: 'uuid' })
  destinationStationId!: string;

  @Column({ name: 'origin_position', type: 'integer' })
  originPosition!: number;

  @Column({ name: 'destination_position', type: 'integer' })
  destinationPosition!: number;

  // Postgres column is int4range; writes use explicit SQL casts.
  @Column({ type: 'text' })
  segment!: string;

  @Column({ type: 'text' })
  outcome!: AllocationOutcome;

  @Column({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;
}
