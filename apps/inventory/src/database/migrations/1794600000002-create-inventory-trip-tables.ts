import type { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateInventoryTripTables1794600000002 implements MigrationInterface {
  name = 'CreateInventoryTripTables1794600000002';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "inventory_trip" (
        "id" uuid PRIMARY KEY,
        "status" varchar(20) NOT NULL,

        CONSTRAINT "chk_inventory_trip_status"
          CHECK ("status" IN ('on_sale', 'closed'))
      )
    `);

    await queryRunner.query(`
      CREATE TABLE "trip_stop" (
        "trip_id" uuid NOT NULL,
        "position" integer NOT NULL CHECK ("position" >= 0),
        "station_id" uuid NOT NULL,

        PRIMARY KEY ("trip_id", "position"),

        CONSTRAINT "fk_trip_stop_trip"
          FOREIGN KEY ("trip_id")
          REFERENCES "inventory_trip"("id")
          ON DELETE CASCADE,

        CONSTRAINT "uq_trip_stop_station"
          UNIQUE ("trip_id", "station_id")
      )
    `);

    await queryRunner.query(`
      CREATE TABLE "trip_coach" (
        "id" uuid PRIMARY KEY,
        "trip_id" uuid NOT NULL,
        "coach_number" integer NOT NULL,
        "travel_class_id" uuid NOT NULL,

        CONSTRAINT "fk_trip_coach_trip"
          FOREIGN KEY ("trip_id")
          REFERENCES "inventory_trip"("id")
          ON DELETE CASCADE,

        CONSTRAINT "uq_trip_coach_number"
          UNIQUE ("trip_id", "coach_number")
      )
    `);

    await queryRunner.query(`
      CREATE TABLE "trip_seat" (
        "id" uuid PRIMARY KEY,
        "trip_id" uuid NOT NULL,
        "trip_coach_id" uuid NOT NULL,
        "seat_number" integer NOT NULL,
        "travel_class_id" uuid NOT NULL,
        "side" varchar(10) NOT NULL,

        CONSTRAINT "fk_trip_seat_coach"
          FOREIGN KEY ("trip_coach_id")
          REFERENCES "trip_coach"("id")
          ON DELETE CASCADE,

        CONSTRAINT "uq_trip_seat_number"
          UNIQUE ("trip_coach_id", "seat_number"),

        CONSTRAINT "chk_trip_seat_side"
          CHECK ("side" IN ('left', 'right'))
      )
    `);

    await queryRunner.query(`
      CREATE INDEX "idx_trip_seat_trip_class"
        ON "trip_seat" ("trip_id", "travel_class_id")
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "trip_seat"`);
    await queryRunner.query(`DROP TABLE "trip_coach"`);
    await queryRunner.query(`DROP TABLE "trip_stop"`);
    await queryRunner.query(`DROP TABLE "inventory_trip"`);
  }
}
