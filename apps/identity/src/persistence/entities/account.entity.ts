import {
  Column,
  CreateDateColumn,
  Entity,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

@Entity({ name: 'accounts' })
export class AccountEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  /** Always stored lowercased. */
  @Column({ type: 'varchar', length: 254, unique: true })
  email: string;

  @Column({ name: 'password_hash', type: 'varchar', length: 255 })
  passwordHash: string;

  @Column({ name: 'verified_at', type: 'timestamptz', nullable: true })
  verifiedAt: Date | null;

  @Column({
    name: 'password_changed_at',
    type: 'timestamptz',
    default: () => 'now()',
  })
  passwordChangedAt: Date;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;
}
