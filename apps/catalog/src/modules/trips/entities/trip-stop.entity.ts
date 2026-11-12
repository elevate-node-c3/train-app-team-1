import {
  Column,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryColumn,
} from 'typeorm';

import { DatedTripEntity } from './dated-trip.entity.js';
import { StationEntity } from '../../stations/entities/station.entity.js';

/**
 * Store absolute stop instants; mirror migration indexes here.
 * Search needs station/day departures and trip/station destination lookups.
 * The partial index includes only boardable stops; without departure, no journey starts.
 */
@Entity('trip_stop')
@Index('idx_trip_stop_station', ['stationId'])
@Index('idx_trip_stop_station_departure', ['stationId', 'departureAt'], {
  where: '"departure_at" IS NOT NULL',
})
@Index('idx_trip_stop_trip_station', ['trip', 'stationId'])
export class TripStopEntity {
  @PrimaryColumn('uuid')
  id!: string;

  @ManyToOne(() => DatedTripEntity, {
    nullable: false,
    onDelete: 'CASCADE',
  })
  @JoinColumn({ name: 'trip_id' })
  trip!: DatedTripEntity;

  @ManyToOne(() => StationEntity, {
    nullable: false,
    onDelete: 'RESTRICT',
  })
  @JoinColumn({ name: 'station_id' })
  station!: StationEntity;

  @Column({ name: 'station_id', type: 'uuid' })
  stationId!: string;

  @Column({ type: 'integer' })
  position!: number;

  @Column({ name: 'arrival_at', type: 'timestamptz', nullable: true })
  arrivalAt!: Date | null;

  @Column({ name: 'departure_at', type: 'timestamptz', nullable: true })
  departureAt!: Date | null;
}
