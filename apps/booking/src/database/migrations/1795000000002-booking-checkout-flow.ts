import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * The checkout flow lives on booking_draft, not a second table: the row the
 * traveller is assembling and the hold it owns are one aggregate, already
 * carrying hold_intent, hold_id, hold_state and hold_version.
 *
 * Added here is only what the draft did not already know:
 * - the flow's own position (flow_state) and its idempotency key
 * - what catalog quoted and what it costs (BR-30, BR-31)
 * - the payment reference and whether a charge was attempted
 * - compensation bookkeeping, and the lease a worker takes to resume a flow
 *
 * Deliberately absent: the passenger snapshot, the held seats, the owner and
 * the travel class. passenger_snapshot, legs, hold_snapshot and user_id
 * already hold them, and hold_snapshot's assignments carry the passenger each
 * seat went to.
 *
 * Events go to the standard outbox_event table the messaging library drains,
 * and inbound hold events are de-duplicated by the existing processed_event
 * table, so neither gets a booking-specific copy.
 */
export class BookingCheckoutFlow1795000000002 implements MigrationInterface {
  name = 'BookingCheckoutFlow1795000000002';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE booking_draft
        ADD COLUMN flow_state varchar(32),
        ADD COLUMN idempotency_key text,
        ADD COLUMN correlation_id text,
        ADD COLUMN travel_class jsonb,
        ADD COLUMN quoted_legs jsonb,
        ADD COLUMN fare_total_piastres integer
          CHECK (fare_total_piastres >= 0),
        ADD COLUMN booking_fee_piastres integer
          CHECK (booking_fee_piastres >= 0),
        ADD COLUMN total_piastres integer
          CHECK (total_piastres >= 0),
        ADD COLUMN terms_accepted_at timestamptz,
        ADD COLUMN payment_reference uuid,
        ADD COLUMN payment_attempted boolean NOT NULL DEFAULT false,
        ADD COLUMN late_payment boolean NOT NULL DEFAULT false,
        ADD COLUMN charge_cancelled boolean NOT NULL DEFAULT false,
        ADD COLUMN hold_released boolean NOT NULL DEFAULT false,
        ADD COLUMN compensation_status varchar(16) NOT NULL DEFAULT 'none',
        ADD COLUMN compensation_attempts integer NOT NULL DEFAULT 0,
        ADD COLUMN compensation_next_attempt_at timestamptz,
        ADD COLUMN compensation_last_error text,
        ADD COLUMN resume_next_attempt_at timestamptz,
        ADD COLUMN lease_until timestamptz,
        ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now(),
        ADD CONSTRAINT chk_booking_draft_flow_state
          CHECK (flow_state IS NULL OR flow_state IN (
            'quote_pending', 'price_locked', 'hold_pending', 'seats_held',
            'payment_starting', 'awaiting_payment', 'expired', 'abandoned',
            'failed'
          )),
        ADD CONSTRAINT chk_booking_draft_compensation_status
          CHECK (compensation_status IN
            ('none', 'pending', 'complete', 'late_payment'))
    `);

    // One submission per (owner, key). A concurrent duplicate becomes a no-op
    // insert, so both requests end up on the same booking.
    await queryRunner.query(`
      CREATE UNIQUE INDEX uq_booking_draft_owner_idempotency
        ON booking_draft (user_id, idempotency_key)
        WHERE idempotency_key IS NOT NULL
    `);

    // The resume worker claims by due time; only live flows are ever due.
    await queryRunner.query(`
      CREATE INDEX idx_booking_draft_resume
        ON booking_draft (resume_next_attempt_at)
        WHERE resume_next_attempt_at IS NOT NULL
    `);

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

    // A compensation that permanently gave up. The messaging dead-letter
    // router covers inbound messages; this records outbound work abandoned
    // after the retry budget, so a human can settle it.
    await queryRunner.query(`
      CREATE TABLE booking_compensation_dead_letter (
        id uuid PRIMARY KEY,
        booking_reference uuid NOT NULL,
        reason text NOT NULL,
        last_error text,
        attempts integer NOT NULL,
        recorded_at timestamptz NOT NULL DEFAULT now()
      )
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE booking_compensation_dead_letter');
    await queryRunner.query('DROP TABLE outbox_event');
    await queryRunner.query('DROP INDEX idx_booking_draft_resume');
    await queryRunner.query('DROP INDEX uq_booking_draft_owner_idempotency');
    await queryRunner.query(`
      ALTER TABLE booking_draft
        DROP CONSTRAINT chk_booking_draft_compensation_status,
        DROP CONSTRAINT chk_booking_draft_flow_state,
        DROP COLUMN updated_at,
        DROP COLUMN lease_until,
        DROP COLUMN resume_next_attempt_at,
        DROP COLUMN compensation_last_error,
        DROP COLUMN compensation_next_attempt_at,
        DROP COLUMN compensation_attempts,
        DROP COLUMN compensation_status,
        DROP COLUMN hold_released,
        DROP COLUMN charge_cancelled,
        DROP COLUMN late_payment,
        DROP COLUMN payment_attempted,
        DROP COLUMN payment_reference,
        DROP COLUMN terms_accepted_at,
        DROP COLUMN total_piastres,
        DROP COLUMN booking_fee_piastres,
        DROP COLUMN fare_total_piastres,
        DROP COLUMN quoted_legs,
        DROP COLUMN travel_class,
        DROP COLUMN correlation_id,
        DROP COLUMN idempotency_key,
        DROP COLUMN flow_state
    `);
  }
}
