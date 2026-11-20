import {
  Column,
  CreateDateColumn,
  Entity,
  PrimaryColumn,
  UpdateDateColumn,
} from 'typeorm';

@Entity('saved_card')
export class SavedCardEntity {
  @PrimaryColumn('uuid')
  id!: string;

  @Column({ name: 'account_id', type: 'uuid' })
  accountId!: string;

  @Column({ name: 'stripe_customer_id', type: 'varchar', length: 128 })
  stripeCustomerId!: string;

  @Column({
    name: 'stripe_payment_method_id',
    type: 'varchar',
    length: 128,
    unique: true,
  })
  stripePaymentMethodId!: string;

  @Column({ type: 'varchar', length: 32 })
  brand!: string;

  @Column({ type: 'varchar', length: 4 })
  last4!: string;

  @Column({ name: 'exp_month', type: 'integer' })
  expMonth!: number;

  @Column({ name: 'exp_year', type: 'integer' })
  expYear!: number;

  @Column({ name: 'cardholder_name', type: 'varchar', length: 255 })
  cardholderName!: string;

  @Column({ type: 'varchar', length: 128 })
  fingerprint!: string;

  @Column({ type: 'varchar', length: 16, default: 'active' })
  status!: 'active' | 'detached';

  @Column({ name: 'last_used_at', type: 'timestamptz', nullable: true })
  lastUsedAt?: Date | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;
}
