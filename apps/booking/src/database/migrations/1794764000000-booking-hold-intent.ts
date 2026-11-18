import type { MigrationInterface, QueryRunner } from 'typeorm';

export class BookingHoldIntent1794764000000 implements MigrationInterface {
  name = 'BookingHoldIntent1794764000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE booking_draft
        ALTER COLUMN expires_at DROP NOT NULL,
        ADD COLUMN request_fingerprint varchar(64),
        ADD COLUMN hold_intent jsonb,
        ADD COLUMN passenger_snapshot jsonb,
        ADD COLUMN hold_requested boolean NOT NULL DEFAULT false,
        ADD COLUMN release_requested boolean NOT NULL DEFAULT false,
        ADD COLUMN hold_id uuid,
        ADD COLUMN hold_state varchar(20)
          CHECK (hold_state IN ('HELD', 'RELEASED', 'EXPIRED', 'CANCELLED')),
        ADD COLUMN hold_version integer NOT NULL DEFAULT 0 CHECK (hold_version >= 0),
        ADD COLUMN hold_snapshot jsonb,
        ADD COLUMN hold_server_now timestamptz,
        ADD COLUMN extension_used boolean NOT NULL DEFAULT false,
        ADD COLUMN reconciliation_pending boolean NOT NULL DEFAULT false,
        ADD COLUMN hold_failure jsonb
    `);
    await queryRunner.query(`
      CREATE TABLE processed_event (
        event_id uuid PRIMARY KEY,
        event_type text NOT NULL,
        status text NOT NULL CHECK (status IN ('processing', 'handled', 'skipped', 'failed')),
        attempt_count integer NOT NULL DEFAULT 1 CHECK (attempt_count > 0),
        claimed_at timestamptz NOT NULL DEFAULT now(),
        handled_at timestamptz,
        skip_reason text,
        last_error text,
        created_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    await queryRunner.query(`
      CREATE INDEX idx_processed_event_processing
        ON processed_event (claimed_at) WHERE status = 'processing'
    `);
  }

  async down(): Promise<void> {
    // Removing these columns loses durable keys and could reallocate a live hold.
    throw new Error('Booking hold intents require a forward-only migration.');
  }
}
