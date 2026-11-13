import { SEARCH_FIXTURE_IDS as IDS } from '../../apps/catalog/src/database/seeds/search-fixture.js';
import { seedSearchFixture } from '../../apps/catalog/src/database/seeds/search-fixture.seed.js';
import { MAX_TRIP_DAY_SPAN_DAYS } from '../../apps/catalog/src/modules/trips/trip-sellability.js';
import type { DataSource } from 'typeorm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  catalogDataSource,
  closeCatalogDataSource,
} from './support/catalog-database.js';

/**
 * Check generator invariants that search depends on; violations can silently
 * hide trips or inflate stop counts.
 */
describe("search's assumptions about generated trip data", () => {
  let source: DataSource;

  beforeAll(async () => {
    source = await catalogDataSource();
    await seedSearchFixture(source);
  });

  afterAll(async () => {
    await closeCatalogDataSource();
  });

  /**
   * The indexed service_date range looks back MAX_TRIP_DAY_SPAN_DAYS and
   * forward one day. Timetable stops outside that bound would be silently
   * pruned before the departure filter.
   */
  it('never plans a stop further ahead than the query looks back', async () => {
    const [{ max_offset: maxOffset }]: { max_offset: number | null }[] =
      await source.query(
        'SELECT max(day_offset)::int AS max_offset FROM timetable_stop',
      );

    expect(
      maxOffset ?? 0,
      `A timetable stop is ${String(maxOffset)} days out but the search query only looks ` +
        `${MAX_TRIP_DAY_SPAN_DAYS} day(s) back. Raise MAX_TRIP_DAY_SPAN_DAYS to at least ` +
        `that, or those trips will silently not be found.`,
    ).toBeLessThanOrEqual(MAX_TRIP_DAY_SPAN_DAYS);
  });

  /**
   * destination.position - origin.position - 1 counts stops only when
   * positions are dense and start at 1.
   */
  it("numbers every trip's stops densely from 1", async () => {
    const gaps: { trip_id: string; stops: number; highest: number }[] =
      await source.query(
        `SELECT trip_id, count(*)::int AS stops, max(position)::int AS highest
           FROM trip_stop
          GROUP BY trip_id
         HAVING count(*) <> max(position) OR min(position) <> 1`,
      );

    expect(
      gaps,
      'These trips have gaps or do not start at 1, so the intermediate-stop ' +
        'count would be wrong for them.',
    ).toEqual([]);
  });

  /** Empty-result probes read timetable positions too. */
  it("numbers every timetable's stops densely from 1", async () => {
    const gaps: { timetable_id: string }[] = await source.query(
      `SELECT timetable_id
         FROM timetable_stop
        GROUP BY timetable_id
       HAVING count(*) <> max(position) OR min(position) <> 1`,
    );

    expect(gaps).toEqual([]);
  });

  /**
   * The double join needs an origin departure and destination arrival;
   * nulls silently hide the pairing.
   */
  it('gives interior stops both an arrival and a departure', async () => {
    const incomplete: { trip_id: string; position: number }[] =
      await source.query(
        `SELECT s.trip_id, s.position
           FROM trip_stop s
           JOIN (
             SELECT trip_id, min(position) AS first, max(position) AS last
               FROM trip_stop GROUP BY trip_id
           ) bounds ON bounds.trip_id = s.trip_id
          WHERE s.position > bounds.first
            AND s.position < bounds.last
            AND (s.arrival_at IS NULL OR s.departure_at IS NULL)`,
      );

    expect(incomplete).toEqual([]);
  });

  /** Empty composition snapshots are filtered as having no coach of any class. */
  it('gives every sellable trip a composition to sell from', async () => {
    const empty: { id: string }[] = await source.query(
      `SELECT id FROM dated_trip
        WHERE status = 'published'
          AND (composition_snapshot IS NULL
               OR jsonb_array_length(composition_snapshot) = 0)`,
    );

    expect(empty).toEqual([]);
  });

  it('still describes the fixture it was seeded with', async () => {
    // An empty fixture would make all invariant checks pass.
    const [{ count }]: { count: number }[] = await source.query(
      'SELECT count(*)::int AS count FROM trip_stop WHERE trip_id = $1',
      [IDS.trips.mainLine],
    );

    expect(count).toBe(7);
  });
});
