import {
  Check,
  Column,
  CreateDateColumn,
  Entity,
  OneToMany,
  PrimaryColumn,
  UpdateDateColumn,
} from 'typeorm';
import type { Relation } from 'typeorm';
import type { CityEntity } from './city.entity.js';

/** Use explicit, nonalphabetical display order, identical in Arabic and English. */
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

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;
  // The inverse side names its target instead of importing it. `city` already
  // imports this file to declare the owning @ManyToOne, so importing it back
  // at runtime would make the two modules circular.
  @OneToMany('CityEntity', 'governorate')
  cities!: Relation<CityEntity[]>;
}
