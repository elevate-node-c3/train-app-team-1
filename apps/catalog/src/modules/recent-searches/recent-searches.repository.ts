import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';

import { fingerprintOf } from './recent-search-fingerprint.js';
import type {
  RecentSearchInput,
  RecentSearchRow,
} from './recent-searches.types.js';

/** The story's cap: the last five per traveller, newest first (BR-21). */
export const RECENT_SEARCH_LIMIT = 5;

interface RawRow {
  origin_station_id: string;
  origin_name_en: string;
  origin_name_ar: string;
  destination_station_id: string;
  destination_name_en: string;
  destination_name_ar: string;
  travel_class_id: string;
  travel_class_name_en: string;
  travel_class_name_ar: string;
  kind: 'one_way' | 'round_trip';
  train_number: number | string | null;
  /** Cast to text by the query, so never a `Date`. */
  departure_date: string | null;
  return_date: string | null;
  searched_at: Date;
}

/**
 * A traveller's recent searches, in their own table.
 *
 * Raw SQL rather than the query builder, for both statements. The write is an
 * `ON CONFLICT ... DO UPDATE` against a named constraint and the trim is a
 * window function; the builder can express neither, and spelling them out is
 * what makes the concurrency guarantee readable.
 */
@Injectable()
export class RecentSearchesRepository {
  constructor(private readonly dataSource: DataSource) {}

  /**
   * Records a search, then trims the traveller back to five.
   *
   * **No read-then-write**, and no count the caller carries: the upsert
   * resolves a duplicate on `uq_recent_search_account_fingerprint`, and the
   * trim deletes by rank. Both run in one transaction, so a crash between them
   * cannot leave a sixth row visible.
   *
   * The advisory lock is what makes the cap hold under concurrency, and it was
   * added because the integration spec proved the obvious version does not.
   * Two clients of one account recording at the same instant open two
   * transactions, and at READ COMMITTED neither one's trim can see the other's
   * uncommitted row -- so both rank five rows, both delete nothing, and the
   * traveller ends up with six. Taking a transaction-scoped lock keyed on the
   * account serializes just those two writers: the second one sees the first's
   * row and trims correctly.
   *
   * Keyed on the account, so travellers never wait for each other, and
   * `hashtext` collisions merely make two unrelated accounts take turns.
   * Recording is already off the search's critical path, so the wait costs a
   * traveller nothing.
   */
  async record(search: RecentSearchInput, now: Date): Promise<void> {
    const fingerprint = fingerprintOf(search);

    await this.dataSource.transaction(async (manager) => {
      // Released when the transaction ends, committed or not -- there is no
      // unlock to forget and nothing to leak on a crash.
      await manager.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
        search.accountId,
      ]);

      // Repeating a search moves it: the dates are overwritten with the new
      // ones, and `searched_at` is what "newest first" then orders by.
      await manager.query(
        `INSERT INTO recent_search (
           id, account_id, fingerprint, origin_station_id,
           destination_station_id, travel_class_id, kind, train_number,
           departure_date, return_date, searched_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
         ON CONFLICT ON CONSTRAINT uq_recent_search_account_fingerprint
         DO UPDATE SET
           departure_date = EXCLUDED.departure_date,
           return_date    = EXCLUDED.return_date,
           searched_at    = EXCLUDED.searched_at`,
        [
          randomUUID(),
          search.accountId,
          fingerprint,
          search.originStationId,
          search.destinationStationId,
          search.travelClassId,
          search.kind,
          search.trainNumber,
          search.departureDate,
          search.returnDate,
          now,
        ],
      );

      // `id DESC` is in the ranking on purpose: two rows can share a
      // `searched_at` to the microsecond, and without a total order the trim
      // would be free to keep either one -- which is a test that passes until
      // it does not.
      await manager.query(
        `DELETE FROM recent_search
         WHERE id IN (
           SELECT id FROM (
             SELECT id, row_number() OVER (
               PARTITION BY account_id
               ORDER BY searched_at DESC, id DESC
             ) AS rank
             FROM recent_search
             WHERE account_id = $1
           ) ranked
           WHERE rank > $2
         )`,
        [search.accountId, RECENT_SEARCH_LIMIT],
      );
    });
  }

  /**
   * The traveller's last five, newest first.
   *
   * Inner joins on `is_active` are the drop rule: an entry whose station has
   * been deactivated disappears rather than being returned as a search that
   * can never answer. It is a join rather than a filter in the service because
   * the station is also where the names come from -- one statement either way.
   *
   * `LIMIT` is applied even though the trim keeps the table at five: the cap is
   * the contract, and a row that slipped past a failed trim must not become a
   * sixth entry on a traveller's screen.
   */
  async list(accountId: string): Promise<RecentSearchRow[]> {
    const raw = await this.dataSource.query<RawRow[]>(
      `SELECT
         r.origin_station_id,
         so.name_en AS origin_name_en,
         so.name_ar AS origin_name_ar,
         r.destination_station_id,
         sd.name_en AS destination_name_en,
         sd.name_ar AS destination_name_ar,
         r.travel_class_id,
         tc.name_en AS travel_class_name_en,
         tc.name_ar AS travel_class_name_ar,
         r.kind,
         r.train_number,
         -- Cast in SQL rather than trusting the driver's date handling: a date
         -- column parsed into a JS Date lands at local midnight, and reading
         -- that back through UTC shifts the traveller's day by one.
         r.departure_date::text AS departure_date,
         r.return_date::text AS return_date,
         r.searched_at
       FROM recent_search r
       JOIN station so
         ON so.id = r.origin_station_id AND so.is_active = true
       JOIN station sd
         ON sd.id = r.destination_station_id AND sd.is_active = true
       JOIN travel_class tc ON tc.id = r.travel_class_id
       WHERE r.account_id = $1
       ORDER BY r.searched_at DESC, r.id DESC
       LIMIT $2`,
      [accountId, RECENT_SEARCH_LIMIT],
    );

    return raw.map((row) => ({
      originStationId: row.origin_station_id,
      originNameEn: row.origin_name_en,
      originNameAr: row.origin_name_ar,
      destinationStationId: row.destination_station_id,
      destinationNameEn: row.destination_name_en,
      destinationNameAr: row.destination_name_ar,
      travelClassId: row.travel_class_id,
      travelClassNameEn: row.travel_class_name_en,
      travelClassNameAr: row.travel_class_name_ar,
      kind: row.kind,
      trainNumber: row.train_number === null ? null : Number(row.train_number),
      departureDate: civilDateOf(row.departure_date),
      returnDate: civilDateOf(row.return_date),
      searchedAt: row.searched_at,
    }));
  }
}

/**
 * A `date` column as the 'YYYY-MM-DD' it is.
 *
 * The query casts to text, so this only trims; the slice is there because a
 * driver that ever returns a timestamp-shaped string must not leak a time into
 * a value that has none.
 */
function civilDateOf(value: string | null): string | null {
  return value === null ? null : value.slice(0, 10);
}
