import type { RecentSearchKindColumn } from './entities/recent-search.entity.js';

/**
 * The shapes the recent-searches path passes between its pieces.
 *
 * They live here rather than beside the repository because the service, the
 * fingerprint and the repository all speak them, and because a
 * `*.repository.ts` is required to export nothing but its concrete class.
 */

/** One search to record, as the search path hands it over. */
export interface RecentSearchInput {
  /** The signed-in traveller, from the verified token. */
  accountId: string;
  originStationId: string;
  destinationStationId: string;
  travelClassId: string;
  kind: RecentSearchKindColumn;
  /** Null means the traveller did not narrow by train. */
  trainNumber: number | null;
  /** Cairo civil dates the traveller picked. */
  departureDate: string;
  /** Null on a one-way search. */
  returnDate: string | null;
}

/**
 * One stored search, joined to the names a client needs to show it.
 *
 * Both languages travel; the edge picks (BR-56). The dates are the stored
 * civil dates -- deciding whether they are too old to repeat is the service's
 * job, because it needs `now`.
 */
export interface RecentSearchRow {
  originStationId: string;
  originNameEn: string;
  originNameAr: string;
  destinationStationId: string;
  destinationNameEn: string;
  destinationNameAr: string;
  travelClassId: string;
  travelClassNameEn: string;
  travelClassNameAr: string;
  kind: RecentSearchKindColumn;
  trainNumber: number | null;
  departureDate: string | null;
  returnDate: string | null;
  searchedAt: Date;
}
