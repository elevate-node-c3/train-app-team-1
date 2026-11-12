import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * BR-52's audit trail. Append-only is enforced by a trigger, not application
 * code, so even a direct `psql` UPDATE or DELETE fails.
 * `(train_id, occurred_at DESC)` serves the newest-first read per train.
 */
export class CreateOperationsAudit1793300000007
  implements MigrationInterface
{
  name = 'CreateOperationsAudit1793300000007';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "operations_audit" (
        "id" uuid PRIMARY KEY,
        "action" text NOT NULL,
        "actor_account_id" uuid NOT NULL,
        "train_id" uuid NOT NULL,
        "before" jsonb,
        "after" jsonb NOT NULL,
        "tickets_affected" integer NOT NULL DEFAULT 0,
        "correlation_id" text NOT NULL,
        "occurred_at" timestamptz NOT NULL DEFAULT now(),

        CONSTRAINT "chk_operations_audit_tickets_affected"
          CHECK ("tickets_affected" >= 0)
      )
    `);

    await queryRunner.query(`
      CREATE INDEX "idx_operations_audit_train_occurred"
      ON "operations_audit" ("train_id", "occurred_at" DESC)
    `);

    await queryRunner.query(`
      CREATE FUNCTION "operations_audit_append_only"()
      RETURNS trigger AS $$
      BEGIN
        RAISE EXCEPTION
          'operations_audit is append-only: % is not permitted', TG_OP;
      END;
      $$ LANGUAGE plpgsql
    `);

    await queryRunner.query(`
      CREATE TRIGGER "trg_operations_audit_append_only"
      BEFORE UPDATE OR DELETE ON "operations_audit"
      FOR EACH ROW
      EXECUTE FUNCTION "operations_audit_append_only"()
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    // Trigger before function: the trigger references it.
    await queryRunner.query(
      `DROP TRIGGER "trg_operations_audit_append_only" ON "operations_audit"`,
    );
    await queryRunner.query(`DROP FUNCTION "operations_audit_append_only"`);
    await queryRunner.query(`DROP TABLE "operations_audit"`);
  }
}
