import {
  Column,
  Entity,
  JoinColumn,
  ManyToOne,
  PrimaryColumn,
} from 'typeorm';
import { TrainEntity } from './train.entity.js';
import { TravelClassEntity } from './travel-class.entity.js';
import { CoachLayoutEntity } from './coach-layout.entity.js';

@Entity('train_coach')
export class TrainCoachEntity {
  @PrimaryColumn('uuid')
  id!: string;

  @ManyToOne(() => TrainEntity, {
    nullable: false,
    onDelete: 'CASCADE',
  })
  @JoinColumn({ name: 'train_id' })
  train!: TrainEntity;

  @Column({ type: 'integer' })
  position!: number;

  @Column({ name: 'coach_number', type: 'integer' })
  coachNumber!: number;

  @ManyToOne(() => TravelClassEntity, {
    nullable: false,
    onDelete: 'RESTRICT',
  })
  @JoinColumn({ name: 'travel_class_id' })
  travelClass!: TravelClassEntity;

  @ManyToOne(() => CoachLayoutEntity, {
    nullable: false,
    onDelete: 'RESTRICT',
  })
  @JoinColumn({ name: 'coach_layout_id' })
  coachLayout!: CoachLayoutEntity;
}