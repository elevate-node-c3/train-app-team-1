import { Check, Column, Entity, Index, JoinColumn, ManyToOne, PrimaryColumn } from 'typeorm';
import type { Relation } from 'typeorm';

import { TripCoachEntity } from './trip-coach.entity.js';

/**
 * trip_id is a denormalized copy of the coach's trip, kept for the
 * (trip_id, travel_class_id) index. The composite FK below (trip_id,
 * trip_coach_id) -> trip_coach (trip_id, id) rejects a seat whose copy
 * disagrees with its coach's real trip, so the denormalization can't drift.
 */
@Entity('trip_seat')
@Index('uq_trip_seat_number', ['tripCoachId', 'seatNumber'], { unique: true })
@Index('idx_trip_seat_trip_class', ['tripId', 'travelClassId'])
// Gives seat_occupation's composite FK a target, same discipline as trip_coach's own mirror.
@Index('uq_trip_seat_trip_id', ['tripId', 'id'], { unique: true })
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
  @JoinColumn([
    { name: 'trip_id', referencedColumnName: 'tripId' },
    { name: 'trip_coach_id', referencedColumnName: 'id' },
  ])
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
