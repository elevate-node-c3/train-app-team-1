import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryColumn,
} from 'typeorm';

@Entity('stripe_event')
@Index('uq_stripe_event_object_type', ['objectId', 'type'], { unique: true })
export class StripeEventEntity {
  @PrimaryColumn('text')
  id!: string;

  @Column({ type: 'text' })
  type!: string;

  /** The Stripe object the event is about, e.g. a payment intent id. */
  @Column({ name: 'object_id', type: 'text' })
  objectId!: string;

  @Column({ type: 'jsonb', default: () => "'{}'" })
  payload!: Record<string, unknown>;

  @CreateDateColumn({ name: 'received_at', type: 'timestamptz' })
  receivedAt!: Date;

  @Column({ name: 'processed_at', type: 'timestamptz', nullable: true })
  processedAt!: Date | null;

  @Column({ type: 'integer', default: 0 })
  attempts!: number;

  @Column({ name: 'last_error', type: 'text', nullable: true })
  lastError!: string | null;
}
