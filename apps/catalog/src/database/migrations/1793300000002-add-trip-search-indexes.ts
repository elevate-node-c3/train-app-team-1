import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Indexes for the one-way search query.
 *
 * The search drives off two predicates that the existing indexes cannot serve:
 * find the stops at a station departing inside a Cairo day, and then, given a
 * trip, find its stop at the destination station. Both degrade to scanning
 * every stop a station has ever had without these.
 *
 * Nothing is added for the fare lookup: `uq_fare_effective_version` is already
 * a btree on exactly (train_id, travel_class_id, origin_station_id,
 * destination_station_id, effective_from), and Postgres reads it backwards for
 * the `ORDER BY effective_from DESC LIMIT 1` that finds the price in force.
 * Nothing is added for `dated_trip` either -- idx_dated_trip_service_date
 * already covers the pruning predicate -- nor for train_number, which is
 * already unique.
 *
 * Each index is declared on its entity too, so a reader of `trip_stop` or
 * `timetable_stop` sees every index the table carries. That mirroring is why
 * none of these use `INCLUDE`: TypeORM's `@Index` has no way to express it, and
 * an index in the database that the entity cannot describe is worse than the
 * one heap fetch per matched row that INCLUDE would have saved -- a cost
 * measured in a day's worth of trips, which is tens of rows.
 */
export class AddTripSearchIndexes1793300000002 implements MigrationInterface {
  async up(queryRunner: QueryRunner): Promise<void> {
    // The origin side, and the one the whole query hangs off. The existing
    // idx_trip_stop_station indexes station_id alone, so it cannot range-scan
    // a day and degrades into a heap filter over every trip that ever called
    // at that station. Partial because a stop with no departure can never be
    // boarded, which keeps the index to the rows the query can use.
    await queryRunner.query(`
      CREATE INDEX "idx_trip_stop_station_departure"
      ON "trip_stop" ("station_id", "departure_at")
      WHERE "departure_at" IS NOT NULL
    `);

    // The destination side. Given the origin row's trip, find the stop at the
    // destination station. UNIQUE (trip_id, position) has the wrong second
    // column for this, so today it scans every stop of the trip.
    await queryRunner.query(`
      CREATE INDEX "idx_trip_stop_trip_station"
      ON "trip_stop" ("trip_id", "station_id")
    `);

    // Both empty-result probes, which ask the timetables whether a pair is
    // served in this direction. Mirrors the index above for the planning
    // tables; idx_timetable_stop_station covers station_id alone, so the
    // second join in each probe re-scans the timetable.
    await queryRunner.query(`
      CREATE INDEX "idx_timetable_stop_timetable_station"
      ON "timetable_stop" ("timetable_id", "station_id")
    `);

    // idx_trip_stop_station is left in place deliberately. It is now a strict
    // prefix of idx_trip_stop_station_departure and therefore redundant, but
    // it belongs to another story's migration and dropping it mid-sprint is a
    // merge hazard. Worth removing once TA-15 and TA-16 have landed.
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX "idx_timetable_stop_timetable_station"`,
    );
    await queryRunner.query(`DROP INDEX "idx_trip_stop_trip_station"`);
    await queryRunner.query(`DROP INDEX "idx_trip_stop_station_departure"`);
  }
}
