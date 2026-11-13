import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Existing indexes cover fares, service dates, and train numbers.
 * Mirror new indexes on their entities; omit INCLUDE because TypeORM cannot
 * express it, accepting a heap fetch per matched row.
 */
export class AddTripSearchIndexes1793300000002 implements MigrationInterface {
  async up(queryRunner: QueryRunner): Promise<void> {
    // Range-scan a station's Cairo-day departures; stops without departures cannot be boarded.
    await queryRunner.query(`
      CREATE INDEX "idx_trip_stop_station_departure"
      ON "trip_stop" ("station_id", "departure_at")
      WHERE "departure_at" IS NOT NULL
    `);

    // Look up the destination by trip and station, not the stop's position.
    await queryRunner.query(`
      CREATE INDEX "idx_trip_stop_trip_station"
      ON "trip_stop" ("trip_id", "station_id")
    `);

    // Empty-result probes need to check directional service without scanning each timetable.
    await queryRunner.query(`
      CREATE INDEX "idx_timetable_stop_timetable_station"
      ON "timetable_stop" ("timetable_id", "station_id")
    `);

    // The redundant idx_trip_stop_station remains; remove it in a separate migration.
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX "idx_timetable_stop_timetable_station"`,
    );
    await queryRunner.query(`DROP INDEX "idx_trip_stop_trip_station"`);
    await queryRunner.query(`DROP INDEX "idx_trip_stop_station_departure"`);
  }
}
