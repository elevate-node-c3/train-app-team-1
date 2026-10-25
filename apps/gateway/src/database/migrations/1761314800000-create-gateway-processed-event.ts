import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * The gateway's consumer ledger. It is intentionally identical in shape to
 * notification's (ADR-0003); each service owns its database, so each keeps its
 * own copy of the claim table rather than sharing a schema.
 */
export class CreateGatewayProcessedEvent1761314800000
  implements MigrationInterface
{
  name = 'CreateGatewayProcessedEvent1761314800000';

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
