import type { DataSource } from 'typeorm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  catalogDataSource,
  closeCatalogDataSource,
} from './support/catalog-database.js';

/**
 * Verify index definitions, not cost-based planner choices on a small fixture.
 * Once migrations are applied, these checks only read PostgreSQL's catalogs.
 */
describe('the trip search indexes', () => {
  let source: DataSource;

  beforeAll(async () => {
    source = await catalogDataSource();
  });

  afterAll(async () => {
    await closeCatalogDataSource();
  });

  async function indexDefinition(indexName: string) {
    const [definition]: {
      tableName: string;
      method: string;
      columns: string[];
      predicate: string | null;
      valid: boolean;
      ready: boolean;
      unique: boolean;
    }[] = await source.query(
      `SELECT t.relname AS "tableName", am.amname AS method,
              ARRAY(
                SELECT pg_get_indexdef(i.indexrelid, k.position, true)
                  FROM generate_series(1, i.indnkeyatts) AS k(position)
                 ORDER BY k.position
              ) AS columns,
              pg_get_expr(i.indpred, i.indrelid) AS predicate,
              i.indisvalid AS valid, i.indisready AS ready,
              i.indisunique AS unique
         FROM pg_index i
         JOIN pg_class c ON c.oid = i.indexrelid
         JOIN pg_class t ON t.oid = i.indrelid
         JOIN pg_namespace n ON n.oid = c.relnamespace
         JOIN pg_am am ON am.oid = c.relam
        WHERE n.nspname = 'public' AND c.relname = $1`,
      [indexName],
    );
    if (!definition) return undefined;

    // PostgreSQL adds cosmetic parentheses and quotes when deparsing predicates.
    definition.predicate =
      definition.predicate?.replace(/[()"]/g, '').replace(/\s+/g, ' ').trim() ??
      null;
    return definition;
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

    /**
     * Only the tables an entity declares. outbox_event and processed_event are
     * the messaging library's, created by its migrations and owned by no
     * entity, so their indexes belong to neither side of this comparison.
     * Reading the list from the metadata keeps a new entity in it by default.
     */
    const entityTables = source.entityMetadatas.map((meta) => meta.tableName);

    const present: { indexname: string }[] = await source.query(
      `SELECT indexname FROM pg_indexes
        WHERE schemaname = 'public' AND indexname LIKE 'idx_%'
          AND tablename = ANY($1)
        ORDER BY indexname`,
      [entityTables],
    );

    expect(declared).toEqual(present.map((row) => row.indexname));
  });

  it('matches the database on columns and partiality, not just names', async () => {
    for (const meta of source.entityMetadatas) {
      for (const index of meta.indices) {
        const definition = await indexDefinition(index.name);
        expect(
          definition,
          `${index.name} is not in the database`,
        ).toBeDefined();
        expect(definition).toMatchObject({
          tableName: meta.tableName,
          columns: index.columns.map((column) => column.databaseName),
          unique: index.isUnique,
          predicate:
            index.where?.replace(/[()"]/g, '').replace(/\s+/g, ' ').trim() ??
            null,
        });
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

  it.each([
    {
      name: 'idx_trip_stop_station_departure',
      tableName: 'trip_stop',
      columns: ['station_id', 'departure_at'],
      predicate: 'departure_at IS NOT NULL',
      unique: false,
    },
    {
      name: 'idx_trip_stop_trip_station',
      tableName: 'trip_stop',
      columns: ['trip_id', 'station_id'],
      predicate: null,
      unique: false,
    },
    {
      name: 'idx_timetable_stop_timetable_station',
      tableName: 'timetable_stop',
      columns: ['timetable_id', 'station_id'],
      predicate: null,
      unique: false,
    },
    {
      name: 'uq_fare_effective_version',
      tableName: 'fare',
      columns: [
        'train_id',
        'travel_class_id',
        'origin_station_id',
        'destination_station_id',
        'effective_from',
      ],
      predicate: null,
      unique: true,
    },
  ])('defines $name for its search lookup', async ({ name, ...expected }) => {
    expect(await indexDefinition(name)).toEqual({
      ...expected,
      method: 'btree',
      valid: true,
      ready: true,
    });
  });
});
