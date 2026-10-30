import { Check, Column, Entity, OneToMany, PrimaryColumn } from 'typeorm';
import { CityEntity } from './city.entity.js';

/*
  Display order is explicit: the design's order is not alphabetical, and it must be identical in Arabic and English.
 */
@Entity('governorate')
@Check('governorate_name_ar_not_empty', `name_ar <> ''`)
@Check('governorate_name_en_not_empty', `name_en <> ''`)
export class GovernorateEntity {
  @PrimaryColumn('uuid')
  id!: string;

  @Column({ name: 'name_ar', type: 'text' })
  nameAr!: string;

  @Column({ name: 'name_en', type: 'text' })
  nameEn!: string;

  @Column({ name: 'sort_order', type: 'int', unique: true })
  sortOrder!: number;

  @OneToMany(() => CityEntity, (city) => city.governorate)
  cities!: CityEntity[];
}