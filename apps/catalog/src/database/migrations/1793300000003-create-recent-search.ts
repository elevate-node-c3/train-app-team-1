import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Catalog owns recent searches as durable data, not Redis cache; no events are published.
 * A unique account/fingerprint pair makes concurrent upserts deduplicate safely.
 * Keep the latest five per account, newest first; the account/time index serves reads and trims.
 * Accounts belong to identity, so account_id has no cross-service foreign key.
 * Station and class references stay within catalog and do have foreign keys.
 */
export class CreateRecentSearch1793300000003 implements MigrationInterface {
  name = 'CreateRecentSearch1793300000003';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "recent_search" (
        "id" uuid NOT NULL,
        "account_id" uuid NOT NULL,
        "fingerprint" text NOT NULL,
        "origin_station_id" uuid NOT NULL,
        "destination_station_id" uuid NOT NULL,
        "travel_class_id" uuid NOT NULL,
        "kind" text NOT NULL,
        "train_number" integer,
        "departure_date" date,
        "return_date" date,
        "searched_at" timestamptz NOT NULL,
        CONSTRAINT "PK_recent_search" PRIMARY KEY ("id"),
        CONSTRAINT "uq_recent_search_account_fingerprint"
          UNIQUE ("account_id", "fingerprint"),
        CONSTRAINT "recent_search_kind_known"
          CHECK ("kind" IN ('one_way', 'round_trip')),
        -- A round trip without an outbound date cannot be repeated as one, so
        -- the pair travels together or not at all.
        CONSTRAINT "recent_search_return_needs_departure"
          CHECK ("return_date" IS NULL OR "departure_date" IS NOT NULL)
      )
    `);

    await queryRunner.query(`
      ALTER TABLE "recent_search"
        ADD CONSTRAINT "FK_recent_search_origin_station"
        FOREIGN KEY ("origin_station_id") REFERENCES "station"("id")
        ON DELETE RESTRICT ON UPDATE NO ACTION
    `);
    await queryRunner.query(`
      ALTER TABLE "recent_search"
        ADD CONSTRAINT "FK_recent_search_destination_station"
        FOREIGN KEY ("destination_station_id") REFERENCES "station"("id")
        ON DELETE RESTRICT ON UPDATE NO ACTION
    `);
    await queryRunner.query(`
      ALTER TABLE "recent_search"
        ADD CONSTRAINT "FK_recent_search_travel_class"
        FOREIGN KEY ("travel_class_id") REFERENCES "travel_class"("id")
        ON DELETE RESTRICT ON UPDATE NO ACTION
    `);

    // Reads and trims both use newest-first order.
    await queryRunner.query(`
      CREATE INDEX "idx_recent_search_account_searched"
      ON "recent_search" ("account_id", "searched_at" DESC)
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX "public"."idx_recent_search_account_searched"`,
    );
    await queryRunner.query(`DROP TABLE "recent_search"`);
  }
}
