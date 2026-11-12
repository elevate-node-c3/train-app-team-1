import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * BR-52's trail: who changed a timetable or a fare, when, what it looked
 * like before and after, how many tickets it touched, and the correlation id
 * that ties the write to the request that caused it.
 *
 * Append-only is enforced here, not in application code. A `BEFORE UPDATE OR
 * DELETE` trigger raises on either statement, so the guarantee holds even
 * against a direct `psql` session -- "the code never issues an UPDATE" is a
 * habit, this is a fact of the schema.
 *
 * `tickets_affected` is `0` every row this sprint (inventory has no seat
 * tables yet), but the column exists now: adding it later would be a
 * migration against a table that cannot be altered by UPDATE once rows
 * exist, only by a fresh column default applying to future inserts.
 *
 * The `(train_id, occurred_at DESC)` index is for the one read this table
 * exists to serve: "who changed this train's fares/timetables, newest
 * first", optionally bounded by date.
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
    // Trigger before function: the trigger references the function, so
    // dropping the function first would fail with a dependency error.
    await queryRunner.query(
      `DROP TRIGGER "trg_operations_audit_append_only" ON "operations_audit"`,
    );
    await queryRunner.query(`DROP FUNCTION "operations_audit_append_only"`);
    await queryRunner.query(`DROP TABLE "operations_audit"`);
  }
}
