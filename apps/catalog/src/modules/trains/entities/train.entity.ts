import {
  Column,
  Entity,
  JoinColumn,
  ManyToOne,
  PrimaryColumn,
} from 'typeorm';
import { TrainTypeEntity } from './train-type.entity.js';

@Entity('train')
export class TrainEntity {
  @PrimaryColumn('uuid')
  id!: string;

  @Column({ name: 'train_number', type: 'integer', unique: true })
  trainNumber!: number;

  @ManyToOne(() => TrainTypeEntity, {
    nullable: false,
    onDelete: 'RESTRICT',
  })
  @JoinColumn({ name: 'train_type_id' })
  trainType!: TrainTypeEntity;
}