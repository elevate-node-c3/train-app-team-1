import {
  Column,
  Entity,
  JoinColumn,
  ManyToOne,
  PrimaryColumn,
} from 'typeorm';
import { TrainEntity } from '../../trains/entities/train.entity.js';

/** 0 = Sunday, matching `Date.getUTCDay()`, which the running-day check uses. */
export enum Weekday {
  Sunday = 0,
  Monday = 1,
  Tuesday = 2,
  Wednesday = 3,
  Thursday = 4,
  Friday = 5,
  Saturday = 6,
}

@Entity('timetable')
export class TimetableEntity {
  @PrimaryColumn('uuid')
  id!: string;

  @ManyToOne(() => TrainEntity, {
    nullable: false,
    onDelete: 'RESTRICT',
  })
  @JoinColumn({ name: 'train_id' })
  train!: TrainEntity;

  @Column({ name: 'running_days', type: 'smallint', array: true })
  runningDays!: Weekday[];

  @Column({ name: 'effective_from', type: 'date' })
  effectiveFrom!: string;

  @Column({
    name: 'effective_until',
    type: 'date',
    nullable: true,
  })
  effectiveUntil!: string | null;

  @Column({ type: 'integer', default: 1 })
  version!: number;

  @Column({
    type: 'varchar',
    length: 20,
    default: 'draft',
  })
  status!: 'draft' | 'published' | 'withdrawn';
}