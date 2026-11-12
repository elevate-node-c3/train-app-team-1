import {
  Column,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryColumn,
} from 'typeorm';

import { TimetableEntity } from './timetable.entity.js';
import { StationEntity } from '../../stations/entities/station.entity.js';

/**
 * Cairo wall-clock time without an offset, plus a day offset.
 * Mirror migration indexes here. Empty-result probes use the plan's ordered
 * station pairs, not dated trips.
 */
@Entity('timetable_stop')
@Index('idx_timetable_stop_station', ['stationId'])
@Index('idx_timetable_stop_timetable_station', ['timetable', 'stationId'])
export class TimetableStopEntity {
  @PrimaryColumn('uuid')
  id!: string;

  @ManyToOne(() => TimetableEntity, {
    nullable: false,
    onDelete: 'CASCADE',
  })
  @JoinColumn({ name: 'timetable_id' })
  timetable!: TimetableEntity;

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

  @Column({ name: 'day_offset', type: 'smallint', default: 0 })
  dayOffset!: number;

  @Column({ name: 'arrival_time', type: 'time', nullable: true })
  arrivalTime!: string | null;

  @Column({ name: 'departure_time', type: 'time', nullable: true })
  departureTime!: string | null;
}
