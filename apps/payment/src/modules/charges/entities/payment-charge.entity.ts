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
  status!: 'started' | 'succeeded' | 'cancelled' | 'refunded';

  @Column({ name: 'card_brand', type: 'varchar', length: 32, nullable: true })
  cardBrand?: string | null;

  @Column({ name: 'card_last4', type: 'varchar', length: 4, nullable: true })
  cardLast4?: string | null;

  @Column({ name: 'stripe_payment_method_id', type: 'varchar', length: 128, nullable: true })
  stripePaymentMethodId?: string | null;

  @Column({ name: 'stripe_payment_intent_id', type: 'varchar', length: 128, nullable: true })
  stripePaymentIntentId?: string | null;
}
