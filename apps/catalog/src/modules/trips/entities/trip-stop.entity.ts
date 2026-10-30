import {
  Column,
  Entity,
  JoinColumn,
  ManyToOne,
  PrimaryColumn,
} from 'typeorm';

import { DatedTripEntity } from './dated-trip.entity.js';
import { StationEntity } from '../../stations/entities/station.entity.js';

@Entity('trip_stop')
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