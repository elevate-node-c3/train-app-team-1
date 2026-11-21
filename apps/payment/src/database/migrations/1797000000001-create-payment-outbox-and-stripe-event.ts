import type { MigrationInterface, QueryRunner } from 'typeorm';

export class CreatePaymentOutboxAndStripeEvent1797000000001
  implements MigrationInterface
{
  name = 'CreatePaymentOutboxAndStripeEvent1797000000001';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE outbox_event (
        id uuid PRIMARY KEY,
        event_type text NOT NULL,
        event_version integer NOT NULL CHECK (event_version > 0),
        routing_key text NOT NULL,
        payload jsonb NOT NULL,
        correlation_id text NOT NULL,
        producer text NOT NULL,
        occurred_at timestamptz NOT NULL,
        published_at timestamptz,
        attempt_count integer NOT NULL DEFAULT 0,
        next_attempt_at timestamptz NOT NULL DEFAULT now(),
        last_error text
      )
    `);

    await queryRunner.query(`
      CREATE INDEX idx_outbox_event_unpublished
        ON outbox_event (next_attempt_at, occurred_at)
        WHERE published_at IS NULL
    `);

    await queryRunner.query(`
      CREATE TABLE stripe_event (
        id text PRIMARY KEY,
        type text NOT NULL,
        object_id text NOT NULL,
        payload jsonb NOT NULL,
        received_at timestamptz NOT NULL DEFAULT now(),
        processed_at timestamptz,
        attempts integer NOT NULL DEFAULT 0,
        last_error text
      )
    `);

    await queryRunner.query(`
      CREATE UNIQUE INDEX uq_stripe_event_object_type
        ON stripe_event (object_id, type)
    `);

    await queryRunner.query(`
      ALTER TABLE payment_charge
        ADD COLUMN stripe_payment_intent_id varchar(128) NULL
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE stripe_event');
    await queryRunner.query('DROP TABLE outbox_event');
  }
}
