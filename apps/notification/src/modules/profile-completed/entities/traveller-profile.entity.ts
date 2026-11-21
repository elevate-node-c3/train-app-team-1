import { Column, Entity, PrimaryColumn } from 'typeorm';

@Entity('traveller_profile')
export class TravellerProfileEntity {
  @PrimaryColumn('uuid', { name: 'account_id' })
  accountId!: string;

  @Column({ name: 'full_name', type: 'text', nullable: true })
  fullName!: string | null;

  @Column({ name: 'email', type: 'text', nullable: true })
  email!: string | null;

  @Column({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @Column({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;
}
