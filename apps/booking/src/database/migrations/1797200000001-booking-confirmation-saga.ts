import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * TA-107's confirmation saga: the four states between a verified payment and
 * a final outcome, the columns that carry the saga's own progress, and the
 * ticket table the confirm step issues into.
 */
export class BookingConfirmationSaga1797200000001 implements MigrationInterface {
  name = 'BookingConfirmationSaga1797200000001';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE booking_draft
        DROP CONSTRAINT chk_booking_draft_flow_state
    `);
    await queryRunner.query(`
      ALTER TABLE booking_draft
        ADD CONSTRAINT chk_booking_draft_flow_state
          CHECK (flow_state IS NULL OR flow_state IN (
            'quote_pending', 'price_locked', 'hold_pending', 'seats_held',
            'payment_starting', 'awaiting_payment', 'expired', 'abandoned',
            'failed', 'confirming', 'confirmed', 'refunding', 'refunded'
          ))
    `);

    await queryRunner.query(`
      ALTER TABLE booking_draft
        ADD COLUMN payment_succeeded_at timestamptz,
        ADD COLUMN payment_event_id uuid,
        ADD COLUMN settlement_outcome varchar(16)
          CHECK (settlement_outcome IS NULL OR settlement_outcome IN
            ('sold', 'reallocated', 'no_seats')),
        ADD COLUMN settled_seats jsonb,
        ADD COLUMN seats_changed boolean NOT NULL DEFAULT false,
        ADD COLUMN tickets_issued_at timestamptz,
        ADD COLUMN refund_reference text,
        ADD COLUMN refunded_at timestamptz,
        ADD COLUMN saga_step varchar(24)
    `);

    await queryRunner.query(`
      CREATE INDEX idx_booking_draft_charged_unsettled
        ON booking_draft (payment_succeeded_at)
        WHERE payment_succeeded_at IS NOT NULL
          AND flow_state NOT IN ('confirmed', 'refunded')
    `);

    await queryRunner.query(`
      CREATE TABLE ticket (
        id uuid PRIMARY KEY,
        booking_reference uuid NOT NULL
          REFERENCES booking_draft (id) ON DELETE CASCADE,
        passenger_ref text NOT NULL,
        trip_id uuid NOT NULL,
        ticket_number text NOT NULL,
        coach_number integer NOT NULL,
        seat_number text NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(),

        CONSTRAINT uq_ticket_passenger_leg
          UNIQUE (booking_reference, passenger_ref, trip_id),

        CONSTRAINT uq_ticket_number
          UNIQUE (ticket_number)
      )
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE ticket');
    await queryRunner.query(
      'DROP INDEX IF EXISTS idx_booking_draft_charged_unsettled',
    );
    await queryRunner.query(`
      ALTER TABLE booking_draft
        DROP COLUMN saga_step,
        DROP COLUMN refunded_at,
        DROP COLUMN refund_reference,
        DROP COLUMN tickets_issued_at,
        DROP COLUMN seats_changed,
        DROP COLUMN settled_seats,
        DROP COLUMN settlement_outcome,
        DROP COLUMN payment_event_id,
        DROP COLUMN payment_succeeded_at
    `);
    await queryRunner.query(`
      ALTER TABLE booking_draft
        DROP CONSTRAINT chk_booking_draft_flow_state
    `);
    await queryRunner.query(`
      ALTER TABLE booking_draft
        ADD CONSTRAINT chk_booking_draft_flow_state
          CHECK (flow_state IS NULL OR flow_state IN (
            'quote_pending', 'price_locked', 'hold_pending', 'seats_held',
            'payment_starting', 'awaiting_payment', 'expired', 'abandoned',
            'failed'
          ))
    `);
  }
}
