import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Claim events before handling to skip redeliveries.
 * Keep this schema aligned with notification's inbox and the shared claim SQL.
 */
export class CreateCatalogProcessedEvent1793300000005 implements MigrationInterface {
  name = 'CreateCatalogProcessedEvent1793300000005';

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

    // Index only processing claims; handled history is not queried for recovery.
    await queryRunner.query(`
      CREATE INDEX idx_processed_event_processing
        ON processed_event (claimed_at)
        WHERE status = 'processing'
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE processed_event');
  }
}
