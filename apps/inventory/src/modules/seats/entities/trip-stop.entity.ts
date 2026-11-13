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

import { InventoryTripEntity } from './inventory-trip.entity.js';

/**
 * Position is the trip's own primary key, not a synthetic id: a trip never
 * has two stops at the same position. There is no StationEntity in inventory,
 * so station_id is a plain copy of catalog's id, never a relation.
 */
@Entity('trip_stop')
@Index('uq_trip_stop_station', ['tripId', 'stationId'], { unique: true })
@Check('chk_trip_stop_position', `"position" >= 0`)
export class TripStopEntity {
  @PrimaryColumn({ name: 'trip_id', type: 'uuid' })
  tripId!: string;

  @ManyToOne(() => InventoryTripEntity, {
    nullable: false,
    onDelete: 'CASCADE',
  })
  @JoinColumn({ name: 'trip_id' })
  trip!: Relation<InventoryTripEntity>;

  @PrimaryColumn({ type: 'integer' })
  position!: number;

  @Column({ name: 'station_id', type: 'uuid' })
  stationId!: string;

  // Stored only; nothing in TA-68 reads these back. Overlap is stop order,
  // never the clock. A terminus has no departure and an origin no arrival.
  @Column({ name: 'arrival_at', type: 'timestamptz', nullable: true })
  arrivalAt!: Date | null;

  @Column({ name: 'departure_at', type: 'timestamptz', nullable: true })
  departureAt!: Date | null;
}
