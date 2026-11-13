import type { RecentSearchKindColumn } from './entities/recent-search.entity.js';

/** Keep shared types outside repositories, which export only their concrete class. */

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
 * Send both languages; the edge chooses. Stored dates are civil dates, and
 * the service uses now to decide whether they are too old to repeat.
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
