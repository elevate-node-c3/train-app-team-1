import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Track handled events by ID and append each delivery attempt.
 * Never store verification codes or other secrets.
 */
export class CreateProcessedEventEmailDelivery1761314500000 implements MigrationInterface {
  name = 'CreateProcessedEventEmailDelivery1761314500000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE processed_event (
        event_id uuid PRIMARY KEY,
        event_type text NOT NULL,
        status text NOT NULL
          CHECK (status IN ('processing', 'handled', 'skipped', 'failed')),
        attempt_count integer NOT NULL DEFAULT 1
          CHECK (attempt_count > 0),
        claimed_at timestamptz NOT NULL DEFAULT now(),
        handled_at timestamptz,
        skip_reason text,
        last_error text,
        created_at timestamptz NOT NULL DEFAULT now()
      )
    `);

    // Only active claims need this lookup index.
    await queryRunner.query(`
      CREATE INDEX idx_processed_event_processing
        ON processed_event (claimed_at)
        WHERE status = 'processing'
    `);

    await queryRunner.query(`
      CREATE TABLE email_delivery (
        id uuid PRIMARY KEY,
        event_id uuid NOT NULL,
        account_id uuid NOT NULL,
        recipient_email text NOT NULL,
        purpose text NOT NULL,
        outcome text NOT NULL
          CHECK (outcome IN ('accepted', 'skipped_expired', 'failed')),
        skip_reason text,
        issued_at timestamptz NOT NULL,
        accepted_at timestamptz,
        latency_ms integer
          CHECK (latency_ms IS NULL OR latency_ms >= 0),
        error_message text,
        created_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT email_delivery_accepted_has_latency
          CHECK (
            outcome <> 'accepted'
            OR (accepted_at IS NOT NULL AND latency_ms IS NOT NULL)
          )
      )
    `);

    // Non-unique so duplicate sends after a crash remain visible.
    await queryRunner.query(`
      CREATE INDEX idx_email_delivery_event_id
        ON email_delivery (event_id)
    `);

    // Delivery percentiles use accepted messages only.
    await queryRunner.query(`
      CREATE INDEX idx_email_delivery_accepted
        ON email_delivery (latency_ms)
        WHERE outcome = 'accepted'
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE email_delivery');
    await queryRunner.query('DROP TABLE processed_event');
  }
}
