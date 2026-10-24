
import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

@Entity({ name: 'user' })
export class User {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Index('uq_accounts_email', { unique: true })
  @Column({ type: 'varchar', length: 254 })
  email!: string;

  @Column({  type: 'varchar', length: 255 })
  passwordHash!: string;

  @Column({ type: 'varchar', length: 35, default: 'en' })
  language!: string;

  @Column({
    name: 'email_verified_at',
    type: 'timestamptz',
    nullable: true,
  })
  emailVerifiedAt!: Date | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({  type: 'timestamptz' })
  updatedAt!: Date;
}
