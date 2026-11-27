import { Column, Entity, PrimaryColumn } from 'typeorm';

@Entity('payment_charge')
/** Durable charge state, remote-intent correlation, and recovery claims. */
export class PaymentChargeEntity {
  @PrimaryColumn('uuid')
  id!: string;

  @Column({ name: 'booking_reference', type: 'uuid', unique: true })
  bookingReference!: string;

  @Column({ name: 'idempotency_key', type: 'text', unique: true })
  idempotencyKey!: string;

  @Column({ name: 'amount_piastres', type: 'integer' })
  amountPiastres!: number;

  @Column({ name: 'refund_amount_piastres', type: 'integer', nullable: true })
  refundAmountPiastres?: number | null;

  @Column({ type: 'varchar', length: 16 })
  currency!: string;

  @Column({ type: 'varchar', length: 16 })
  status!: 'started' | 'succeeded' | 'cancelled' | 'refunded';

  @Column({ name: 'card_brand', type: 'varchar', length: 32, nullable: true })
  cardBrand?: string | null;

  @Column({ name: 'card_last4', type: 'varchar', length: 4, nullable: true })
  cardLast4?: string | null;

  @Column({
    name: 'stripe_payment_method_id',
    type: 'varchar',
    length: 128,
    nullable: true,
  })
  stripePaymentMethodId?: string | null;

  @Column({
    name: 'stripe_payment_intent_id',
    type: 'varchar',
    length: 128,
    nullable: true,
  })
  stripePaymentIntentId?: string | null;

  @Column({
    name: 'intent_creation_started_at',
    type: 'timestamptz',
    nullable: true,
  })
  intentCreationStartedAt?: Date | null;

  @Column({ name: 'intent_creation_claim', type: 'uuid', nullable: true })
  intentCreationClaim?: string | null;

  @Column({
    name: 'intent_creation_lease_until',
    type: 'timestamptz',
    nullable: true,
  })
  intentCreationLeaseUntil?: Date | null;

  @Column({ name: 'intent_creation_last_error', type: 'text', nullable: true })
  intentCreationLastError?: string | null;

  @Column({
    name: 'stripe_customer_id',
    type: 'varchar',
    length: 128,
    nullable: true,
  })
  stripeCustomerId?: string | null;

  @Column({
    name: 'cancellation_requested_at',
    type: 'timestamptz',
    nullable: true,
  })
  cancellationRequestedAt?: Date | null;
}
