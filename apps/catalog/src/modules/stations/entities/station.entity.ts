import {
  Check,
  Column,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryColumn,
} from 'typeorm';
import { CityEntity } from './city.entity.js';
import type { Relation } from 'typeorm';

/**
 * A station belongs to a city, and the city to a governorate. The governorate
 * is never stored here, so the two can not disagree.
 * A station that trips still stop at is deactivated, never deleted.
 */
@Entity('station')
@Check('station_name_ar_not_empty', `name_ar <> ''`)
@Check('station_name_en_not_empty', `name_en <> ''`)
export class StationEntity {
  @PrimaryColumn('uuid')
  id!: string;

  @Index('idx_station_city')
  @Column({ name: 'city_id', type: 'uuid' })
  cityId!: string;

  @ManyToOne(() => CityEntity, (city) => city.stations, {
    nullable: false,
    onDelete: 'RESTRICT',
  })
  @JoinColumn({ name: 'city_id' })
  city!: Relation<CityEntity>;

  @Column({ name: 'name_ar', type: 'text' })
  nameAr!: string;

  @Column({ name: 'name_en', type: 'text' })
  nameEn!: string;

  /** Explicit extra spellings, for example ['Ramses'] for Ramsis. */
  @Column({
    name: 'alt_spellings',
    type: 'text',
    array: true,
    default: () => 'ARRAY[]::text[]',
  })
  altSpellings!: string[];

  @Column({ name: 'is_active', type: 'boolean', default: true })
  isActive!: boolean;

}