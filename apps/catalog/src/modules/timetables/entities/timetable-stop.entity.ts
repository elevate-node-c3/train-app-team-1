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
 * A planned stop, in naive Cairo wall-clock time plus a day offset.
 *
 * Both indexes are declared here as well as in their migrations. The composite
 * one serves the empty-result probes, which ask whether a timetable stops at
 * two stations in travel order -- a question about the plan, not about any
 * date, which is why it is answered here rather than from the dated trips.
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
