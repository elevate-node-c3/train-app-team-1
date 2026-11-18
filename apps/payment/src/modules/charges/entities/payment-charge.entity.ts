import { Column, Entity, PrimaryColumn } from 'typeorm';

@Entity('payment_charge')
/** Persisted idempotency record for the payment contract test double. */
export class PaymentChargeEntity {
  @PrimaryColumn('uuid')
  id!: string;

  @Column({ name: 'booking_reference', type: 'uuid', unique: true })
  bookingReference!: string;

  @Column({ name: 'idempotency_key', type: 'text', unique: true })
  idempotencyKey!: string;

  @Column({ name: 'amount_piastres', type: 'integer' })
  amountPiastres!: number;

  @Column({ type: 'varchar', length: 16 })
  currency!: string;

  @Column({ type: 'varchar', length: 16 })
  status!: 'started' | 'succeeded' | 'cancelled';
}
