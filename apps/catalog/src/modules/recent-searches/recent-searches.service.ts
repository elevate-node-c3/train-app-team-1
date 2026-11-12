import { Injectable, Logger } from '@nestjs/common';
import {
  cairoToday,
  civilDateTimeOf,
  type ListRecentSearchesResponse,
  type RecentSearch,
  type RecentSearchKind,
} from '@app/contracts';

import { RecentSearchesRepository } from './recent-searches.repository.js';
import type {
  RecentSearchInput,
  RecentSearchRow,
} from './recent-searches.types.js';

/**
 * Map stored kinds explicitly; the database constraint makes UNSPECIFIED unreachable.
 */
const KIND_ON_THE_WIRE: Record<RecentSearchInput['kind'], RecentSearchKind> = {
  one_way: 'RECENT_SEARCH_KIND_ONE_WAY',
  round_trip: 'RECENT_SEARCH_KIND_ROUND_TRIP',
};

/**
 * Never cache per-traveller recent searches: shared keys would leak account data,
 * and per-account caching is not part of this feature.
 */
@Injectable()
export class RecentSearchesService {
  private readonly logger = new Logger(RecentSearchesService.name);

  constructor(private readonly repository: RecentSearchesRepository) {}

  async list(
    accountId: string,
    now: Date,
  ): Promise<ListRecentSearchesResponse> {
    const rows = await this.repository.list(accountId);

    return { recentSearches: rows.map((row) => this.toWire(row, now)) };
  }

  /**
   * Recording must never delay or fail search responses; swallow and warn on errors.
   * Callers run it off the response's critical path.
   */
  async record(search: RecentSearchInput, now: Date): Promise<void> {
    try {
      await this.repository.record(search, now);
    } catch (error: unknown) {
      // Warn rather than debug: this is a write that was supposed to happen.
      this.logger.warn(
        `Could not record a recent search: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  /**
   * If departure is missing or past, omit both dates so the client asks for new ones.
   * Never return half a round-trip date pair. Send both languages; the edge chooses,
   * and request.language does not filter names here.
   */
  private toWire(row: RecentSearchRow, now: Date): RecentSearch {
    const repeatable =
      row.departureDate !== null && row.departureDate >= cairoToday(now)
        ? {
            departureDate: row.departureDate,
            ...(row.returnDate === null ? {} : { returnDate: row.returnDate }),
          }
        : {};

    return {
      origin: {
        id: row.originStationId,
        name: { en: row.originNameEn, ar: row.originNameAr },
      },
      destination: {
        id: row.destinationStationId,
        name: { en: row.destinationNameEn, ar: row.destinationNameAr },
      },
      travelClass: {
        id: row.travelClassId,
        name: { en: row.travelClassNameEn, ar: row.travelClassNameAr },
      },
      kind: KIND_ON_THE_WIRE[row.kind],
      ...(row.trainNumber === null ? {} : { trainNumber: row.trainNumber }),
      ...repeatable,
      searchedAt: civilDateTimeOf(row.searchedAt),
    };
  }
}
