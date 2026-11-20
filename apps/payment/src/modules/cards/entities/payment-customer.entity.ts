import { Column, CreateDateColumn, Entity, PrimaryColumn } from 'typeorm';

@Entity('payment_customer')
export class PaymentCustomerEntity {
  @PrimaryColumn('uuid')
  id!: string;

  @Column({ name: 'account_id', type: 'uuid', unique: true })
  accountId!: string;

  @Column({
    name: 'stripe_customer_id',
    type: 'varchar',
    length: 128,
    unique: true,
  })
  stripeCustomerId!: string;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;
}
