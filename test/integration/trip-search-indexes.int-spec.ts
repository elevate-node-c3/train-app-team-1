import { SEARCH_FIXTURE_IDS as IDS } from '../../apps/catalog/src/database/seeds/search-fixture.js';
import { seedSearchFixture } from '../../apps/catalog/src/database/seeds/search-fixture.seed.js';
import { cairoDayBounds } from '@app/contracts';
import type { DataSource } from 'typeorm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  catalogDataSource,
  closeCatalogDataSource,
} from './support/catalog-database.js';

/**
 * The small fixture favors sequential scans, so disable them to check index
 * coverage. This proves the indexes can serve the predicates, not that Postgres
 * will choose them on production data.
 */
describe('the trip search indexes', () => {
  let source: DataSource;

  beforeAll(async () => {
    source = await catalogDataSource();
    await seedSearchFixture(source);
  });

  afterAll(async () => {
    await closeCatalogDataSource();
  });

  /**
   * SET LOCAL and EXPLAIN must share one connection and transaction;
   * pooled DataSource.query calls may not. Rollback keeps the setting local.
   */
  async function planFor(sql: string, parameters: unknown[]): Promise<string> {
    const runner = source.createQueryRunner();
    await runner.connect();
    await runner.startTransaction();

    try {
      await runner.query('SET LOCAL enable_seqscan = off');
      const rows: Record<string, string>[] = await runner.query(
        `EXPLAIN ${sql}`,
        parameters,
      );
      return rows.map((row) => Object.values(row)[0]).join('\n');
    } finally {
      await runner.rollbackTransaction();
      await runner.release();
    }
  }

  it('creates all three, and leaves the ones it did not author alone', async () => {
    const rows: { indexname: string }[] = await source.query(
      `SELECT indexname FROM pg_indexes
        WHERE schemaname = 'public'
          AND indexname = ANY($1::text[])`,
      [
        [
          'idx_trip_stop_station_departure',
          'idx_trip_stop_trip_station',
          'idx_timetable_stop_timetable_station',
          // Keep the pre-existing prefix index owned by an earlier migration.
          'idx_trip_stop_station',
          'idx_dated_trip_service_date',
        ],
      ],
    );

    expect(rows.map((row) => row.indexname).sort()).toEqual([
      'idx_dated_trip_service_date',
      'idx_timetable_stop_timetable_station',
      'idx_trip_stop_station',
      'idx_trip_stop_station_departure',
      'idx_trip_stop_trip_station',
    ]);
  });

  /** Compare both directions so missing and undocumented indexes cannot pass. */
  it('declares on the entities exactly the indexes the database has', async () => {
    const declared = source.entityMetadatas
      .flatMap((meta) => meta.indices)
      .map((index) => index.name)
      .filter((name): name is string => Boolean(name))
      .sort();

    const present: { indexname: string }[] = await source.query(
      `SELECT indexname FROM pg_indexes
        WHERE schemaname = 'public' AND indexname LIKE 'idx_%'
        ORDER BY indexname`,
    );

    expect(declared).toEqual(present.map((row) => row.indexname));
  });

  it('matches the database on columns and partiality, not just names', async () => {
    const definitions: { indexname: string; indexdef: string }[] =
      await source.query(
        `SELECT indexname, indexdef FROM pg_indexes
          WHERE schemaname = 'public' AND indexname LIKE 'idx_%'`,
      );
    const byName = new Map(
      definitions.map((row) => [row.indexname, row.indexdef]),
    );

    for (const meta of source.entityMetadatas) {
      for (const index of meta.indices) {
        const definition = byName.get(index.name);
        expect(definition, `${index.name} is not in the database`).toBeDefined();

        for (const column of index.columns) {
          expect(
            definition,
            `${index.name} is missing ${column.databaseName}`,
          ).toContain(column.databaseName);
        }

        // A partial index must retain a WHERE clause.
        if (index.where) {
          expect(definition?.toUpperCase()).toContain('WHERE');
        }
      }
    }
  });

  it('reports every index as valid', async () => {
    const invalid: { relname: string }[] = await source.query(
      `SELECT c.relname
         FROM pg_class c
         JOIN pg_index i ON i.indexrelid = c.oid
        WHERE c.relname LIKE 'idx_%' AND NOT i.indisvalid`,
    );

    expect(invalid).toEqual([]);
  });

  // Origin departures are filtered to a Cairo day.
  it('can serve the origin side with the station-and-departure index', async () => {
    const { startUtc, endUtc } = cairoDayBounds('2026-06-20');

    const plan = await planFor(
      `SELECT trip_id FROM trip_stop
        WHERE station_id = $1 AND departure_at >= $2 AND departure_at < $3
          AND departure_at IS NOT NULL`,
      [IDS.stations.alexandria, startUtc, endUtc],
    );

    expect(plan).toContain('idx_trip_stop_station_departure');
  });

  it('can serve the destination side with the trip-and-station index', async () => {
    const plan = await planFor(
      `SELECT position, arrival_at FROM trip_stop
        WHERE trip_id = $1 AND station_id = $2`,
      [IDS.trips.mainLine, IDS.stations.ramsis],
    );

    expect(plan).toContain('idx_trip_stop_trip_station');
  });

  it('can serve the probes with the timetable-and-station index', async () => {
    const plan = await planFor(
      `SELECT position FROM timetable_stop
        WHERE timetable_id = $1 AND station_id = $2`,
      [IDS.timetables.mainLine, IDS.stations.ramsis],
    );

    expect(plan).toContain('idx_timetable_stop_timetable_station');
  });

  // The fare's unique index supports a backward scan; no extra index is needed.
  it('can serve the fare lookup from the existing unique index', async () => {
    const plan = await planFor(
      `SELECT amount_piastres FROM fare
        WHERE train_id = $1 AND travel_class_id = $2
          AND origin_station_id = $3 AND destination_station_id = $4
          AND effective_from <= $5
        ORDER BY effective_from DESC
        LIMIT 1`,
      [
        IDS.trains.mainLine,
        IDS.travelClasses.first,
        IDS.stations.alexandria,
        IDS.stations.ramsis,
        new Date('2026-06-15T09:00:00Z'),
      ],
    );

    expect(plan).toContain('uq_fare_effective_version');
  });
});
