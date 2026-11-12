import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';

import { fingerprintOf } from './recent-search-fingerprint.js';
import type {
  RecentSearchInput,
  RecentSearchRow,
} from './recent-searches.types.js';

/** Keep the latest five searches per traveller, newest first. */
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

/** Use raw SQL for named-constraint upserts and rank-based trims. */
@Injectable()
export class RecentSearchesRepository {
  constructor(private readonly dataSource: DataSource) {}

  /**
   * Upsert on account/fingerprint and trim by rank in one transaction.
   * A transaction-scoped account lock enforces the five-row cap at READ COMMITTED:
   * concurrent trims cannot see uncommitted inserts and could otherwise leave six.
   * hashtext collisions only serialize unrelated accounts. Recording stays off
   * the search response's critical path.
   */
  async record(search: RecentSearchInput, now: Date): Promise<void> {
    const fingerprint = fingerprintOf(search);

    await this.dataSource.transaction(async (manager) => {
      // Transaction-scoped locks release on commit or rollback.
      await manager.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
        search.accountId,
      ]);

      // Repeats update dates and searched_at, moving the row to the top.
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

      // Break searched_at ties with id so trimming and listing share a total order.
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
   * Return at most five, newest first, even if a trim failed.
   * Join active stations for names and omit entries whose station was deactivated.
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

/** Return only YYYY-MM-DD; driver timestamp-shaped strings must not leak time. */
function civilDateOf(value: string | null): string | null {
  return value === null ? null : value.slice(0, 10);
}
