import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * One row per `Idempotency-Key` a client has sent (TA-20). The fingerprint
 * lets a repeat with different content be told apart from a genuine retry;
 * the stored response is what a genuine retry gets back instead of redoing
 * the work.
 */
export class CreateOperationsRequest1793300000008
  implements MigrationInterface
{
  name = 'CreateOperationsRequest1793300000008';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "operations_request" (
        "idempotency_key" text PRIMARY KEY,
        "fingerprint" text NOT NULL,
        "response_json" jsonb NOT NULL,
        "created_at" timestamptz NOT NULL DEFAULT now()
      )
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "operations_request"`);
  }
}
