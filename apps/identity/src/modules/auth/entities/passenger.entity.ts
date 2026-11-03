import { Column, Entity, PrimaryColumn } from 'typeorm';

@Entity('passenger')
export class PassengerEntity {
  @PrimaryColumn('uuid')
  id!: string;

  @Column({ name: 'account_id', type: 'uuid' })
  accountId!: string;

  @Column({ name: 'full_name', type: 'text' })
  fullName!: string;

  @Column({ name: 'national_id', type: 'text' })
  nationalId!: string;

  @Column({ name: 'profile_type', type: 'text' })
  profileType!: string;

  @Column({ type: 'text' })
  nationality!: string;

  @Column({ name: 'is_self', type: 'boolean', default: false })
  isSelf!: boolean;

  @Column({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @Column({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;
}

