import type { MigrationInterface, QueryRunner } from 'typeorm';

/** Store each Idempotency-Key's fingerprint and response for safe retries. */
export class CreateOperationsRequest1793300000008 implements MigrationInterface {
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
