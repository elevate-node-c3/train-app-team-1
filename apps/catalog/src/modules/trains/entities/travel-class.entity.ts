import { Column, Entity, PrimaryColumn } from 'typeorm';

@Entity('travel_class')
export class TravelClassEntity {
  @PrimaryColumn('uuid')
  id!: string;

  @Column({ name: 'name_en', type: 'varchar', length: 80 })
  nameEn!: string;

  @Column({ name: 'name_ar', type: 'varchar', length: 80 })
  nameAr!: string;
}