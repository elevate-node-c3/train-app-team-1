import { Column, Entity, PrimaryColumn } from 'typeorm';

@Entity('profile_type')
export class ProfileTypeEntity {
  @PrimaryColumn('text')
  code!: string;

  @Column({ name: 'name_ar', type: 'text' })
  nameAr!: string;

  @Column({ name: 'name_en', type: 'text' })
  nameEn!: string;
}

