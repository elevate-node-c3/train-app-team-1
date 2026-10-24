
import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { User } from './user.entity.js';

export enum VerificationPurpose {
  EMAIL_VERIFICATION = 'EMAIL_VERIFICATION',
  PASSWORD_RESET = 'PASSWORD_RESET',
}

@Entity({ name: 'verification_codes' })
@Index('idx_verification_codes_user', ['userId'])
export class VerificationCode {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

@Column({ name: 'user_id', type: 'uuid' })
userId!: string;

@ManyToOne(() => User, { onDelete: 'CASCADE' })
@JoinColumn({ name: 'user_id', referencedColumnName: 'id' })
user!: User;

  @Column({
    type: 'enum',
    enum: VerificationPurpose,
  })
  purpose!: VerificationPurpose;

  @Column({ name: 'code_hash', type: 'varchar', length: 64 })
  codeHash!: string;

  @Column({ name: 'expires_at', type: 'timestamptz' })
  expiresAt!: Date;

  @Column({ name: 'used_at', type: 'timestamptz', nullable: true })
  usedAt!: Date | null;

  @Column({
    name: 'invalidated_at',
    type: 'timestamptz',
    nullable: true,
  })
  invalidatedAt!: Date | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;
}
