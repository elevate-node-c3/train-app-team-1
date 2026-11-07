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
 * Column value to wire enum, spelled out so neither can drift silently.
 *
 * UNSPECIFIED is deliberately unreachable: a stored row always knows which
 * kind it is, and a check constraint on the column keeps it that way.
 */
const KIND_ON_THE_WIRE: Record<RecentSearchInput['kind'], RecentSearchKind> = {
  one_way: 'RECENT_SEARCH_KIND_ONE_WAY',
  round_trip: 'RECENT_SEARCH_KIND_ROUND_TRIP',
};

/**
 * The traveller's last five searches (CAT-4, BR-21).
 *
 * Deliberately has no cache. Recent searches are per traveller, so a shared
 * cache key is the one thing §2.3 rule 6 forbids outright, and a per-traveller
 * key would buy a few milliseconds on a once-per-screen read in exchange for a
 * place another account's data could leak through. The module provides no
 * `CacheAsideService` at all, so there is nothing to misuse.
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
   * Records a search for a traveller, or says why it could not.
   *
   * Returns rather than throws, and the caller ignores the answer: recording
   * must never slow a search down and never make one fail (BR-21). A traveller
   * who gets their trains and no new recent-search entry has lost nothing they
   * asked for; a traveller who gets an error instead of their trains has.
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
   * One stored row on the wire.
   *
   * A search whose departure date has passed comes back **without its dates**,
   * so the client knows to ask for new ones rather than replaying a journey
   * that cannot be booked. Both dates go together: a round trip with no
   * outbound date cannot be repeated either, and returning half a pair would
   * invite a client to fill in the other half itself.
   *
   * Station names travel in both languages and the edge picks (BR-56) --
   * `language` on the request is carried, never acted on here.
   */
  private toWire(row: RecentSearchRow, now: Date): RecentSearch {
    const stale =
      row.departureDate === null || row.departureDate < cairoToday(now);

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
      ...(stale
        ? {}
        : {
            departureDate: row.departureDate,
            ...(row.returnDate === null ? {} : { returnDate: row.returnDate }),
          }),
      searchedAt: civilDateTimeOf(row.searchedAt),
    };
  }
}
