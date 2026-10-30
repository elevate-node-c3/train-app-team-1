import {
  Column,
  Entity,
  JoinColumn,
  ManyToOne,
  PrimaryColumn,
} from 'typeorm';

import { TrainEntity } from '../../trains/entities/train.entity.js';
import { TravelClassEntity } from '../../trains/entities/travel-class.entity.js';

@Entity('fare')
export class FareEntity {
  @PrimaryColumn('uuid')
  id!: string;

  @ManyToOne(() => TrainEntity, { nullable: false, onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'train_id' })
  train!: TrainEntity;

  @ManyToOne(() => TravelClassEntity, {
    nullable: false,
    onDelete: 'RESTRICT',
  })
  @JoinColumn({ name: 'travel_class_id' })
  travelClass!: TravelClassEntity;

  @Column({ name: 'origin_station_id', type: 'uuid' })
  originStationId!: string;

  @Column({ name: 'destination_station_id', type: 'uuid' })
  destinationStationId!: string;

  @Column({ name: 'amount_piastres', type: 'integer' })
  amountPiastres!: number;

  @Column({ name: 'effective_from', type: 'timestamptz' })
  effectiveFrom!: Date;
}