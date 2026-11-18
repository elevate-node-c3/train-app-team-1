import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * MT-08/MT-10 expansion phase: durable hold heads, passenger/leg snapshots,
 * allocation receipts, and occupation identity columns. Creation stays
 * disabled until the service path is wired; existing anonymous occupancy is
 * preserved because every new column is nullable.
 */
export class CreateHoldCore1794600000008 implements MigrationInterface {
  name = 'CreateHoldCore1794600000008';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "seat_hold_group" (
        "id" uuid PRIMARY KEY,
        "booking_key" text NOT NULL,
        "owner_id" uuid NOT NULL,
        "request_fingerprint" text NOT NULL,
        "state" text NOT NULL,
        "version" integer NOT NULL DEFAULT 1,
        "extension_used" boolean NOT NULL DEFAULT false,
        "expires_at" timestamptz,
        "released_at" timestamptz,
        "created_at" timestamptz NOT NULL,
        "updated_at" timestamptz NOT NULL,

        CONSTRAINT "uq_seat_hold_group_booking_key" UNIQUE ("booking_key"),

        CONSTRAINT "chk_seat_hold_group_state"
          CHECK ("state" IN ('held', 'released', 'expired', 'cancelled')),

        CONSTRAINT "chk_seat_hold_group_version"
          CHECK ("version" > 0),

        CONSTRAINT "chk_seat_hold_group_held_expiry"
          CHECK ("state" <> 'held' OR "expires_at" IS NOT NULL)
      )
    `);

    // One unresolved HELD group per traveller. Expired-but-unreleased heads
    // intentionally still occupy this index until the create or expiry path
    // releases them, which is what makes replacement atomic.
    await queryRunner.query(`
      CREATE UNIQUE INDEX "uq_seat_hold_group_owner_active"
        ON "seat_hold_group" ("owner_id")
        WHERE ("state" = 'held')
    `);

    await queryRunner.query(`
      CREATE INDEX "idx_seat_hold_group_due"
        ON "seat_hold_group" ("expires_at")
        WHERE ("state" = 'held')
    `);

    // Owner-level create serialization. The guard row exists only to give
    // same-traveller creates one lock target before they read the active hold.
    await queryRunner.query(`
      CREATE TABLE "seat_hold_owner_guard" (
        "owner_id" uuid PRIMARY KEY,
        "created_at" timestamptz NOT NULL DEFAULT now()
      )
    `);

    await queryRunner.query(`
      CREATE TABLE "seat_hold_passenger" (
        "id" uuid PRIMARY KEY,
        "hold_id" uuid NOT NULL,
        "trip_id" uuid NOT NULL,
        "passenger_ref" text NOT NULL,
        "passenger_token" text NOT NULL,
        "passenger_key_version" integer NOT NULL,
        "created_at" timestamptz NOT NULL,

        CONSTRAINT "fk_seat_hold_passenger_hold"
          FOREIGN KEY ("hold_id")
          REFERENCES "seat_hold_group" ("id")
          ON DELETE CASCADE,

        CONSTRAINT "uq_seat_hold_passenger_ref"
          UNIQUE ("hold_id", "trip_id", "passenger_ref"),

        CONSTRAINT "chk_seat_hold_passenger_key_version"
          CHECK ("passenger_key_version" > 0)
      )
    `);

    await queryRunner.query(`
      CREATE TABLE "seat_hold_leg" (
        "id" uuid PRIMARY KEY,
        "hold_id" uuid NOT NULL,
        "trip_id" uuid NOT NULL,
        "travel_class_id" uuid NOT NULL,
        "origin_station_id" uuid NOT NULL,
        "destination_station_id" uuid NOT NULL,
        "origin_position" integer NOT NULL,
        "destination_position" integer NOT NULL,
        "segment" int4range NOT NULL,
        "outcome" text NOT NULL,
        "created_at" timestamptz NOT NULL,

        CONSTRAINT "fk_seat_hold_leg_hold"
          FOREIGN KEY ("hold_id")
          REFERENCES "seat_hold_group" ("id")
          ON DELETE CASCADE,

        CONSTRAINT "uq_seat_hold_leg_trip"
          UNIQUE ("hold_id", "trip_id"),

        CONSTRAINT "chk_seat_hold_leg_segment"
          CHECK (NOT isempty("segment") AND lower("segment") >= 0),

        CONSTRAINT "chk_seat_hold_leg_outcome"
          CHECK ("outcome" IN ('SIDE_BY_SIDE', 'SAME_COACH', 'SPLIT'))
      )
    `);

    await queryRunner.query(`
      CREATE TABLE "seat_hold_assignment" (
        "id" uuid PRIMARY KEY,
        "hold_id" uuid NOT NULL,
        "passenger_ref" text NOT NULL,
        "passenger_key_version" integer NOT NULL,
        "trip_id" uuid NOT NULL,
        "trip_seat_id" uuid NOT NULL,
        "travel_class_id" uuid NOT NULL,
        "coach_number" integer NOT NULL,
        "seat_number" text NOT NULL,
        "row_number" integer NOT NULL,
        "label" text,
        "outcome" text NOT NULL,
        "origin_station_id" uuid NOT NULL,
        "destination_station_id" uuid NOT NULL,
        "origin_position" integer NOT NULL,
        "destination_position" integer NOT NULL,
        "segment" int4range NOT NULL,
        "created_at" timestamptz NOT NULL,

        CONSTRAINT "fk_seat_hold_assignment_hold"
          FOREIGN KEY ("hold_id")
          REFERENCES "seat_hold_group" ("id")
          ON DELETE CASCADE,

        CONSTRAINT "uq_seat_hold_assignment_passenger"
          UNIQUE ("hold_id", "passenger_ref", "trip_id"),

        CONSTRAINT "uq_seat_hold_assignment_seat"
          UNIQUE ("hold_id", "trip_id", "trip_seat_id"),

        CONSTRAINT "chk_seat_hold_assignment_outcome"
          CHECK ("outcome" IN ('SIDE_BY_SIDE', 'SAME_COACH', 'SPLIT'))
      )
    `);

    await queryRunner.query(`
      ALTER TABLE "seat_occupation"
        ADD COLUMN "hold_id" uuid,
        ADD COLUMN "owner_id" uuid,
        ADD COLUMN "passenger_ref" text,
        ADD COLUMN "passenger_token" text,
        ADD COLUMN "passenger_key_version" integer
    `);

    await queryRunner.query(`
      ALTER TABLE "seat_occupation"
        ADD CONSTRAINT "fk_seat_occupation_hold"
          FOREIGN KEY ("hold_id")
          REFERENCES "seat_hold_group" ("id")
          ON DELETE CASCADE
    `);

    await queryRunner.query(`
      ALTER TABLE "seat_occupation"
        ADD CONSTRAINT "chk_seat_occupation_passenger_key_version"
          CHECK (
            "passenger_key_version" IS NULL
            OR "passenger_key_version" > 0
          )
    `);

    await queryRunner.query(`
      CREATE INDEX "idx_seat_occupation_hold"
        ON "seat_occupation" ("hold_id")
        WHERE ("hold_id" IS NOT NULL)
    `);

    // Global passenger-overlap protection: one trip-scoped token cannot hold
    // overlapping segments on any seat or class within that trip. Touching
    // ranges still pass, and the same traveller may hold separate trips.
    await queryRunner.query(`
      ALTER TABLE "seat_occupation"
        ADD CONSTRAINT "excl_seat_occupation_passenger_overlap"
          EXCLUDE USING gist (
            "passenger_token" WITH =,
            "trip_id" WITH =,
            "segment" WITH &&
          )
          WHERE ("released_at" IS NULL AND "passenger_token" IS NOT NULL)
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    const [usage]: { hasProtectedData: boolean }[] = await queryRunner.query(`
      SELECT
        EXISTS (SELECT 1 FROM "seat_hold_group")
        OR EXISTS (SELECT 1 FROM "seat_hold_owner_guard")
        OR EXISTS (SELECT 1 FROM "seat_hold_passenger")
        OR EXISTS (SELECT 1 FROM "seat_hold_leg")
        OR EXISTS (SELECT 1 FROM "seat_hold_assignment")
        OR EXISTS (
          SELECT 1
          FROM "seat_occupation"
          WHERE "hold_id" IS NOT NULL
             OR "owner_id" IS NOT NULL
             OR "passenger_ref" IS NOT NULL
             OR "passenger_token" IS NOT NULL
             OR "passenger_key_version" IS NOT NULL
        ) AS "hasProtectedData"
    `);
    if (usage?.hasProtectedData !== false) {
      throw new Error(
        'Cannot roll back MT-02 hold storage while hold heads, receipts, owner guards, passenger snapshots, or referenced occupations exist. Disable hold creation and use a forward migration that preserves committed hold data.',
      );
    }

    await queryRunner.query(`
      ALTER TABLE "seat_occupation"
        DROP CONSTRAINT IF EXISTS "excl_seat_occupation_passenger_overlap"
    `);

    await queryRunner.query(`DROP INDEX IF EXISTS "idx_seat_occupation_hold"`);
    await queryRunner.query(`
      ALTER TABLE "seat_occupation"
        DROP CONSTRAINT IF EXISTS "chk_seat_occupation_passenger_key_version",
        DROP CONSTRAINT IF EXISTS "fk_seat_occupation_hold"
    `);
    await queryRunner.query(`
      ALTER TABLE "seat_occupation"
        DROP COLUMN IF EXISTS "passenger_key_version",
        DROP COLUMN IF EXISTS "passenger_token",
        DROP COLUMN IF EXISTS "passenger_ref",
        DROP COLUMN IF EXISTS "owner_id",
        DROP COLUMN IF EXISTS "hold_id"
    `);

    await queryRunner.query(`DROP TABLE IF EXISTS "seat_hold_assignment"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "seat_hold_leg"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "seat_hold_passenger"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "seat_hold_group"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "seat_hold_owner_guard"`);
  }
}
