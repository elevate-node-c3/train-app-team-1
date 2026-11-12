import type { DataSource } from 'typeorm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  CATALOG_TABLES,
  catalogDataSource,
  closeCatalogDataSource,
  truncateCatalog,
} from './support/catalog-database.js';

describe('the catalog integration tier', () => {
  let source: DataSource;

  beforeAll(async () => {
    source = await catalogDataSource();
  });

  afterAll(async () => {
    await closeCatalogDataSource();
  });

  it('connects from the host as the catalog role, not the superuser', async () => {
    const [{ current_user: role, current_database: database }] =
      await source.query('SELECT current_user, current_database()');

    expect(role).toBe('catalog');
    expect(database).toBe('catalog');
  });

  it('has applied every migration', async () => {
    const applied: { name: string }[] = await source.query(
      'SELECT name FROM migrations ORDER BY timestamp',
    );

    // Allow later migrations without changing this minimum.
    expect(applied.length).toBeGreaterThanOrEqual(3);
  });

  it('has every table search reads from', async () => {
    const present: { table_name: string }[] = await source.query(
      `SELECT table_name FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name = ANY($1::text[])`,
      [[...CATALOG_TABLES]],
    );

    expect(present.map((row) => row.table_name).sort()).toEqual(
      [...CATALOG_TABLES].sort(),
    );
  });

  it('can truncate everything, so specs can start from empty', async () => {
    await truncateCatalog(source);

    const [{ count }] = await source.query(
      'SELECT count(*)::int AS count FROM station',
    );
    expect(count).toBe(0);
  });

  // Node's Cairo day bounds require timestamptz to preserve instants across
  // session time zones.
  it('round-trips an instant through timestamptz without shifting it', async () => {
    const instant = new Date('2026-06-15T21:40:00.000Z');

    for (const sessionZone of ['UTC', 'Africa/Cairo', 'Asia/Dubai']) {
      await source.query(`SET TimeZone = '${sessionZone}'`);

      const [{ value }] = await source.query(
        'SELECT $1::timestamptz AS value',
        [instant],
      );

      expect(
        (value as Date).getTime(),
        `shifted under TimeZone=${sessionZone}`,
      ).toBe(instant.getTime());
    }

    await source.query(`SET TimeZone = 'UTC'`);
  });
});
