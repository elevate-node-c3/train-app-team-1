import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * btree_gist lets the exclusion constraint combine = (trip_seat_id) and &&
 * (segment) in one gist index. Dropping it in `down` is safe only while
 * nothing else in inventory's database uses it, which is true at this commit.
 */
export class CreateSeatOccupation1794600000004 implements MigrationInterface {
  name = 'CreateSeatOccupation1794600000004';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('CREATE EXTENSION IF NOT EXISTS btree_gist');

    await queryRunner.query(`
      CREATE TABLE "seat_occupation" (
        "id" uuid PRIMARY KEY,
        "trip_seat_id" uuid NOT NULL,
        "trip_id" uuid NOT NULL,
        "segment" int4range NOT NULL,
        "state" text NOT NULL,
        "hold_expires_at" timestamptz,
        "released_at" timestamptz,
        "reference_id" uuid,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "updated_at" timestamptz NOT NULL DEFAULT now(),

        -- Composite FK: Postgres rejects an occupation whose trip_id disagrees
        -- with the trip its trip_seat_id actually belongs to. A separate
        -- trip_id -> inventory_trip FK would be transitively redundant via
        -- trip_seat.trip_id -> trip_coach(trip_id, id) -> inventory_trip, so
        -- it is omitted rather than carrying two paths to the same guarantee.
        CONSTRAINT "fk_seat_occupation_seat"
          FOREIGN KEY ("trip_id", "trip_seat_id")
          REFERENCES "trip_seat" ("trip_id", "id")
          ON DELETE RESTRICT,

        CONSTRAINT "chk_seat_occupation_state"
          CHECK ("state" IN ('held', 'sold')),

        -- isempty() closes the int4range(n,n) hole: an empty range never
        -- overlaps anything, so a zero-length occupation would otherwise
        -- slip past the exclusion constraint below.
        CONSTRAINT "chk_seat_occupation_segment"
          CHECK (NOT isempty("segment") AND lower("segment") >= 0),

        CONSTRAINT "chk_seat_occupation_hold_expiry"
          CHECK (("state" = 'held') = ("hold_expires_at" IS NOT NULL)),

        -- WHERE released_at IS NULL, not a now() comparison: an index
        -- predicate can't call now(), so an expired-but-unreleased hold
        -- still blocks until something writes released_at.
        CONSTRAINT "excl_seat_occupation_overlap"
          EXCLUDE USING gist ("trip_seat_id" WITH =, "segment" WITH &&)
            WHERE ("released_at" IS NULL)
      )
    `);

    await queryRunner.query(`
      CREATE INDEX "idx_seat_occupation_trip" ON "seat_occupation" ("trip_id")
        WHERE ("released_at" IS NULL)
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "seat_occupation"`);

    // Safe only while nothing else in inventory's database uses btree_gist.
    await queryRunner.query('DROP EXTENSION IF EXISTS btree_gist');
  }
}
