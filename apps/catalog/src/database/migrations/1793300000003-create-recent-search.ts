import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * A traveller's recent searches (BR-21, CAT-4).
 *
 * Catalog's own table in catalog's own database: recent searches are data this
 * service owns, not a cache of someone else's, which is why they survive a
 * Redis restart and why no event is published about them.
 *
 * Two constraints carry the rules the story states:
 *
 * UNIQUE (account_id, fingerprint) is the dedupe guarantee. "The last 5 per
 * traveller, newest first, without duplicates" has to hold when two clients of
 * the same account search at the same instant, and a read-then-write cannot
 * promise that. With this in place the write is an upsert on a conflict target,
 * so the database decides, not the application.
 *
 * The (account_id, searched_at DESC) index serves both the read and the trim,
 * which are the only two queries this table ever answers.
 *
 * `account_id` has no foreign key on purpose. Accounts live in identity's
 * database and a cross-service constraint is what §2.3 forbids; the station and
 * class references do get one, because they are catalog's own rows.
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

    // DESC because every read is "newest first", and the trim ranks by the
    // same order. An ascending index would be read backwards, which works but
    // says the wrong thing about what this table is for.
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
