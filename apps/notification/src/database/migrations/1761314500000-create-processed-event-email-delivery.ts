import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Notification's own schema. Hand-written for the same reason as identity's:
 * the idempotency guard is a primary key, and the delivery log is append-only
 * because a duplicate send must be visible as a second row (ADR-0003).
 *
 * There is deliberately no column that could hold a verification code or any
 * other secret. The code lives only in the event body and in the email.
 */
export class CreateProcessedEventEmailDelivery1761314500000
  implements MigrationInterface
{
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

    // Partial: the stuck-claim query in the runbook only ever looks at
    // `processing`, so handled history does not belong in this index.
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

    // Deliberately non-unique: a crash between SMTP accepting and the handled
    // marker produces a second row, and the latency report must count what
    // actually happened over the wire rather than deduplicate it away.
    await queryRunner.query(`
      CREATE INDEX idx_email_delivery_event_id
        ON email_delivery (event_id)
    `);

    // The BR-03 percentile query filters on this outcome.
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
