import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Catalog's inbox. Its cache invalidation consumer (CAT-5) claims every event
 * in this table before handling it, so a redelivery is skipped rather than
 * applied twice.
 *
 * Same shape as notification's, because the claim SQL is shared
 * (libs/messaging/src/consumer/processed-event.sql.ts). The schema-agreement
 * spec holds both copies to it.
 */
export class CreateCatalogProcessedEvent1793300000005
  implements MigrationInterface
{
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

    // Partial: only stuck claims are ever queried, so handled history does not
    // belong in this index.
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
