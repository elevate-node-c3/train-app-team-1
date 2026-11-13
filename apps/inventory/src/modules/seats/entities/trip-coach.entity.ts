import { Column, Entity, Index, JoinColumn, ManyToOne, PrimaryColumn } from 'typeorm';
import type { Relation } from 'typeorm';

import { InventoryTripEntity } from './inventory-trip.entity.js';

/** There is no TravelClassEntity in inventory; travel_class_id is a plain copy of catalog's id. */
@Entity('trip_coach')
@Index('uq_trip_coach_number', ['tripId', 'coachNumber'], { unique: true })
export class TripCoachEntity {
  @PrimaryColumn('uuid')
  id!: string;

  @ManyToOne(() => InventoryTripEntity, {
    nullable: false,
    onDelete: 'CASCADE',
  })
  @JoinColumn({ name: 'trip_id' })
  trip!: Relation<InventoryTripEntity>;

  @Column({ name: 'trip_id', type: 'uuid' })
  tripId!: string;

  @Column({ name: 'coach_number', type: 'integer' })
  coachNumber!: number;

  @Column({ name: 'travel_class_id', type: 'uuid' })
  travelClassId!: string;
}
