import { Check, Column, Entity, JoinColumn, ManyToOne, PrimaryColumn } from 'typeorm';
import type { Relation } from 'typeorm';

import { TripSeatEntity } from './trip-seat.entity.js';

/**
 * trip_id is a denormalized copy of the seat's trip, guarded the same way as
 * trip_seat's own copy: the composite FK (trip_id, trip_seat_id) -> trip_seat
 * (trip_id, id) rejects an occupation whose copy disagrees with its seat's
 * real trip. A separate trip_id -> inventory_trip FK would be transitively
 * redundant through that chain, so it is not declared here.
 */
@Entity('seat_occupation')
@Check('chk_seat_occupation_state', `"state" IN ('held', 'sold')`)
@Check('chk_seat_occupation_segment', `NOT isempty("segment") AND lower("segment") >= 0`)
@Check(
  'chk_seat_occupation_hold_expiry',
  `("state" = 'held') = ("hold_expires_at" IS NOT NULL)`,
)
export class SeatOccupationEntity {
  @PrimaryColumn('uuid')
  id!: string;

  @Column({ name: 'trip_id', type: 'uuid' })
  tripId!: string;

  @ManyToOne(() => TripSeatEntity, {
    nullable: false,
    onDelete: 'RESTRICT',
  })
  @JoinColumn([
    { name: 'trip_id', referencedColumnName: 'tripId' },
    { name: 'trip_seat_id', referencedColumnName: 'id' },
  ])
  seat!: Relation<TripSeatEntity>;

  @Column({ name: 'trip_seat_id', type: 'uuid' })
  tripSeatId!: string;

  // Postgres column is really int4range; parseInt4Range turns this literal
  // (e.g. "[0,2)") into a Segment. TypeORM has no int4range column type.
  @Column({ type: 'text' })
  segment!: string;

  @Column({ type: 'text' })
  state!: 'held' | 'sold';

  @Column({ name: 'hold_expires_at', type: 'timestamptz', nullable: true })
  holdExpiresAt!: Date | null;

  @Column({ name: 'released_at', type: 'timestamptz', nullable: true })
  releasedAt!: Date | null;

  @Column({ name: 'reference_id', type: 'uuid', nullable: true })
  referenceId!: string | null;

  @Column({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @Column({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;
}
