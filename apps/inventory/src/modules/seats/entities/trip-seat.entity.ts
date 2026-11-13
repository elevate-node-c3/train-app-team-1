import { Check, Column, Entity, Index, JoinColumn, ManyToOne, PrimaryColumn } from 'typeorm';
import type { Relation } from 'typeorm';

import { TripCoachEntity } from './trip-coach.entity.js';

/**
 * trip_id is a denormalized copy of the coach's trip, kept only for the
 * (trip_id, travel_class_id) index; cascade deletion flows through the coach.
 */
@Entity('trip_seat')
@Index('uq_trip_seat_number', ['tripCoachId', 'seatNumber'], { unique: true })
@Index('idx_trip_seat_trip_class', ['tripId', 'travelClassId'])
@Check('chk_trip_seat_side', `"side" IN ('left', 'right')`)
export class TripSeatEntity {
  @PrimaryColumn('uuid')
  id!: string;

  @Column({ name: 'trip_id', type: 'uuid' })
  tripId!: string;

  @ManyToOne(() => TripCoachEntity, {
    nullable: false,
    onDelete: 'CASCADE',
  })
  @JoinColumn({ name: 'trip_coach_id' })
  coach!: Relation<TripCoachEntity>;

  @Column({ name: 'trip_coach_id', type: 'uuid' })
  tripCoachId!: string;

  @Column({ name: 'seat_number', type: 'integer' })
  seatNumber!: number;

  @Column({ name: 'travel_class_id', type: 'uuid' })
  travelClassId!: string;

  @Column({ type: 'varchar', length: 10 })
  side!: 'left' | 'right';
}
