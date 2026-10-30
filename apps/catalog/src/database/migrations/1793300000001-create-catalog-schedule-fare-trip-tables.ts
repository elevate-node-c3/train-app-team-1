import type { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateCatalogScheduleFareTripTables1793300000001
  implements MigrationInterface
{
  name = 'CreateCatalogScheduleFareTripTables1793300000001';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "timetable" (
        "id" uuid PRIMARY KEY,
        "train_id" uuid NOT NULL,
        "running_days" smallint[] NOT NULL,
        "effective_from" date NOT NULL,
        "effective_until" date,
        "version" integer NOT NULL DEFAULT 1,
        "status" varchar(20) NOT NULL DEFAULT 'draft',

        CONSTRAINT "fk_timetable_train"
          FOREIGN KEY ("train_id")
          REFERENCES "train"("id")
          ON DELETE RESTRICT,

        CONSTRAINT "uq_timetable_train_version"
          UNIQUE ("train_id", "version"),

        CONSTRAINT "chk_timetable_version"
          CHECK ("version" > 0),

        CONSTRAINT "chk_timetable_status"
          CHECK ("status" IN ('draft', 'published', 'withdrawn')),

        CONSTRAINT "chk_timetable_dates"
          CHECK (
            "effective_until" IS NULL
            OR "effective_until" >= "effective_from"
          ),

        CONSTRAINT "chk_timetable_running_days"
          CHECK (
            cardinality("running_days") > 0
            AND "running_days" <@ ARRAY[0,1,2,3,4,5,6]::smallint[]
          )
      )
    `);

    await queryRunner.query(`
      CREATE TABLE "timetable_stop" (
        "id" uuid PRIMARY KEY,
        "timetable_id" uuid NOT NULL,
        "station_id" uuid NOT NULL,
        "position" integer NOT NULL,
        "day_offset" smallint NOT NULL DEFAULT 0,
        "arrival_time" time,
        "departure_time" time,

        CONSTRAINT "fk_timetable_stop_timetable"
          FOREIGN KEY ("timetable_id")
          REFERENCES "timetable"("id")
          ON DELETE CASCADE,

        CONSTRAINT "fk_timetable_stop_station"
          FOREIGN KEY ("station_id")
          REFERENCES "station"("id")
          ON DELETE RESTRICT,

        CONSTRAINT "uq_timetable_stop_position"
          UNIQUE ("timetable_id", "position"),

        CONSTRAINT "chk_timetable_stop_position"
          CHECK ("position" > 0),

        CONSTRAINT "chk_timetable_stop_day_offset"
          CHECK ("day_offset" >= 0),

        CONSTRAINT "chk_timetable_stop_time"
          CHECK (
            "arrival_time" IS NOT NULL
            OR "departure_time" IS NOT NULL
          )
      )
    `);

    await queryRunner.query(`
      CREATE TABLE "fare" (
        "id" uuid PRIMARY KEY,
        "train_id" uuid NOT NULL,
        "travel_class_id" uuid NOT NULL,
        "origin_station_id" uuid NOT NULL,
        "destination_station_id" uuid NOT NULL,
        "amount_piastres" integer NOT NULL,
        "effective_from" timestamptz NOT NULL,

        CONSTRAINT "fk_fare_train"
          FOREIGN KEY ("train_id")
          REFERENCES "train"("id")
          ON DELETE RESTRICT,

        CONSTRAINT "fk_fare_class"
          FOREIGN KEY ("travel_class_id")
          REFERENCES "travel_class"("id")
          ON DELETE RESTRICT,

        CONSTRAINT "fk_fare_origin_station"
          FOREIGN KEY ("origin_station_id")
          REFERENCES "station"("id")
          ON DELETE RESTRICT,

        CONSTRAINT "fk_fare_destination_station"
          FOREIGN KEY ("destination_station_id")
          REFERENCES "station"("id")
          ON DELETE RESTRICT,

        CONSTRAINT "chk_fare_positive"
          CHECK ("amount_piastres" > 0),

        CONSTRAINT "chk_fare_different_stations"
          CHECK ("origin_station_id" <> "destination_station_id"),

        CONSTRAINT "uq_fare_effective_version"
          UNIQUE (
            "train_id",
            "travel_class_id",
            "origin_station_id",
            "destination_station_id",
            "effective_from"
          )
      )
    `);

    await queryRunner.query(`
      CREATE TABLE "dated_trip" (
        "id" uuid PRIMARY KEY,
        "train_id" uuid NOT NULL,
        "timetable_id" uuid NOT NULL,
        "service_date" date NOT NULL,
        "timetable_version" integer NOT NULL,
        "composition_snapshot" jsonb NOT NULL,
        "status" varchar(20) NOT NULL DEFAULT 'draft',
        "published_at" timestamptz,
        "created_at" timestamptz NOT NULL DEFAULT now(),

        CONSTRAINT "fk_dated_trip_train"
          FOREIGN KEY ("train_id")
          REFERENCES "train"("id")
          ON DELETE RESTRICT,

        CONSTRAINT "fk_dated_trip_timetable"
          FOREIGN KEY ("timetable_id")
          REFERENCES "timetable"("id")
          ON DELETE RESTRICT,

        CONSTRAINT "uq_dated_trip_train_date"
          UNIQUE ("train_id", "service_date"),

        CONSTRAINT "chk_dated_trip_version"
          CHECK ("timetable_version" > 0),

        CONSTRAINT "chk_dated_trip_status"
          CHECK ("status" IN ('draft', 'published', 'withdrawn'))
      )
    `);

    await queryRunner.query(`
      CREATE TABLE "trip_stop" (
        "id" uuid PRIMARY KEY,
        "trip_id" uuid NOT NULL,
        "station_id" uuid NOT NULL,
        "position" integer NOT NULL,
        "arrival_at" timestamptz,
        "departure_at" timestamptz,

        CONSTRAINT "fk_trip_stop_trip"
          FOREIGN KEY ("trip_id")
          REFERENCES "dated_trip"("id")
          ON DELETE CASCADE,

        CONSTRAINT "fk_trip_stop_station"
          FOREIGN KEY ("station_id")
          REFERENCES "station"("id")
          ON DELETE RESTRICT,

        CONSTRAINT "uq_trip_stop_position"
          UNIQUE ("trip_id", "position"),

        CONSTRAINT "chk_trip_stop_position"
          CHECK ("position" > 0),

        CONSTRAINT "chk_trip_stop_time"
          CHECK (
            "arrival_at" IS NOT NULL
            OR "departure_at" IS NOT NULL
          )
      )
    `);

    await queryRunner.query(`
      CREATE INDEX "idx_timetable_stop_station"
      ON "timetable_stop" ("station_id")
    `);

    await queryRunner.query(`
      CREATE INDEX "idx_dated_trip_service_date"
      ON "dated_trip" ("service_date", "status")
    `);

    await queryRunner.query(`
      CREATE INDEX "idx_trip_stop_station"
      ON "trip_stop" ("station_id")
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "trip_stop"`);
    await queryRunner.query(`DROP TABLE "dated_trip"`);
    await queryRunner.query(`DROP TABLE "fare"`);
    await queryRunner.query(`DROP TABLE "timetable_stop"`);
    await queryRunner.query(`DROP TABLE "timetable"`);
  }
}