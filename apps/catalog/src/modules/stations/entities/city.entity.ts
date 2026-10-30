import {
  Check,
  Column,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  OneToMany,
  PrimaryColumn,
} from 'typeorm';
import { GovernorateEntity } from './governorate.entity.js';
import { StationEntity } from './station.entity.js';
import type { Relation } from 'typeorm';

@Entity('city')
@Check('city_name_ar_not_empty', `name_ar <> ''`)
@Check('city_name_en_not_empty', `name_en <> ''`)
export class CityEntity {
  @PrimaryColumn('uuid')
  id!: string;

  @Index('idx_city_governorate')
  @Column({ name: 'governorate_id', type: 'uuid' })
  governorateId!: string;

  @ManyToOne(() => GovernorateEntity, (governorate) => governorate.cities, {
    nullable: false,
    onDelete: 'RESTRICT',
  })
  @JoinColumn({ name: 'governorate_id' })
  governorate!: Relation<GovernorateEntity>;

  @Column({ name: 'name_ar', type: 'text' })
  nameAr!: string;

  @Column({ name: 'name_en', type: 'text' })
  nameEn!: string;

  @OneToMany(() => StationEntity, (station) => station.city)
  stations!: Relation<StationEntity[]>;
}