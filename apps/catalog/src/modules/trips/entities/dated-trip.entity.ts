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
 * One coach of a trip's train, frozen at publication.
 *
 * Exported because search reads it to work out the trip's capacity in a travel
 * class, so the shape is a published contract rather than a private detail. A
 * published trip must keep describing the train it was published with, even
 * after the live composition changes.
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
 * A train running on one date, with its composition frozen at publication.
 *
 * The index is declared here as well as in its migration. Search uses it to
 * prune by date and status; which trips actually belong to the searched day is
 * then decided by the passenger's origin departure, not by `service_date`.
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
