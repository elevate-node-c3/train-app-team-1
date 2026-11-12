import {
  SEARCH_FIXTURE_IDS as IDS,
} from '../../apps/catalog/src/database/seeds/search-fixture.js';
import { seedSearchFixture } from '../../apps/catalog/src/database/seeds/search-fixture.seed.js';
import { MAX_TRIP_DAY_SPAN_DAYS } from '../../apps/catalog/src/modules/trips/trip-sellability.js';
import type { DataSource } from 'typeorm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  catalogDataSource,
  closeCatalogDataSource,
} from './support/catalog-database.js';

/**
 * What the search query assumes about the data TA-16 generates.
 *
 * Two of these assumptions fail silently if they stop holding: the query
 * returns fewer rows, or a wrong stop count, with no error anywhere. That is
 * the worst kind of coupling between two stories, so rather than agreeing the
 * rules in conversation and hoping, they are asserted against whatever is
 * actually in the database.
 *
 * If one fails after TA-16's generator lands, the generator and this file
 * disagree -- and the message says which assumption broke.
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
   * The query prunes on `service_date BETWEEN date - MAX_TRIP_DAY_SPAN_DAYS
   * AND date + 1` so the service_date index stays usable. A timetable whose
   * stops reach further than that bound would have its trips pruned away
   * before the departure range ever saw them: the trip simply would not appear,
   * with nothing logged.
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
   * The intermediate-stop count is `destination.position - origin.position - 1`,
   * which is only the number of stops between them while positions are dense
   * and 1-based. A gap inflates the count, and a traveller sees a journey with
   * stops that do not exist.
   */
  it('numbers every trip\'s stops densely from 1', async () => {
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

  /** The same, for the plans the empty-result probes read. */
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
   * A stop a passenger can board must have a departure, and one they can alight
   * at must have an arrival -- the double join requires both, so a null makes
   * the trip invisible for that pairing rather than wrong.
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

  /**
   * Capacity is summed out of `composition_snapshot`, so a published trip with
   * an empty snapshot can never be a result -- it would be filtered as "no
   * coach of this class" whatever class was asked for.
   */
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
    // Guards the guards: if the fixture stopped loading, every assertion above
    // would pass against an empty table and prove nothing.
    const [{ count }]: { count: number }[] = await source.query(
      'SELECT count(*)::int AS count FROM trip_stop WHERE trip_id = $1',
      [IDS.trips.mainLine],
    );

    expect(count).toBe(7);
  });
});
