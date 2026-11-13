import {
  Column,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryColumn,
} from 'typeorm';

import { TrainEntity } from '../../trains/entities/train.entity.js';
import { TimetableEntity } from '../../timetables/entities/timetable.entity.js';
import { CoachLayoutRow } from '../../trains/entities/coach-layout.entity.js';

/**
 * Publish coach composition as a contract for class capacity.
 * Trips retain that snapshot even when the live train composition changes.
 */
export interface TrainCoachCompositionSnapshotItem {
  position: number;
  coachNumber: number;

  travelClass: {
    id: string;
    nameEn: string;
    nameAr: string;
  };

  coachLayout: {
    id: string;
    layoutName: string;
    rows: CoachLayoutRow[];
  };
}

/**
 * Freeze composition at publication. Mirror migration indexes here.
 * service_date/status prune search rows; the passenger's origin departure
 * determines the actual searched date.
 */
@Entity('dated_trip')
@Index('idx_dated_trip_service_date', ['serviceDate', 'status'])
export class DatedTripEntity {
  @PrimaryColumn('uuid')
  id!: string;

  @ManyToOne(() => TrainEntity, { nullable: false, onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'train_id' })
  train!: TrainEntity;

  @ManyToOne(() => TimetableEntity, {
    nullable: false,
    onDelete: 'RESTRICT',
  })
  @JoinColumn({ name: 'timetable_id' })
  timetable!: TimetableEntity;

  @Column({ name: 'service_date', type: 'date' })
  serviceDate!: string;

  @Column({ name: 'timetable_version', type: 'integer' })
  timetableVersion!: number;

  @Column({ name: 'composition_snapshot', type: 'jsonb' })
  compositionSnapshot!: TrainCoachCompositionSnapshotItem[];

  @Column({
    type: 'varchar',
    length: 20,
    default: 'draft',
  })
  status!: 'draft' | 'published' | 'withdrawn';

  @Column({ name: 'published_at', type: 'timestamptz', nullable: true })
  publishedAt!: Date | null;

  @Column({
    name: 'created_at',
    type: 'timestamptz',
    default: () => 'now()',
  })
  createdAt!: Date;
}
