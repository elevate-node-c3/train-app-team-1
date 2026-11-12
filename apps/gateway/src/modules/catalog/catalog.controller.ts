import { Controller, Get, Headers, Param, Query } from '@nestjs/common';
import { RateLimit, RequireAccess, resolveLanguage } from '@app/common';
import type {
  ListRecentSearchesResponse,
  TripStopsResponse,
} from '@app/contracts';

import {
  CatalogService,
  type SearchReturnTripsResult,
  type SearchTripsResult,
} from './catalog.service.js';
import { RecentSearchesQueryDto } from './dto/recent-searches.dto.js';
import { SearchReturnTripsDto } from './dto/search-return-trips.dto.js';
import { SearchTripsDto } from './dto/search-trips.dto.js';
import { TripIdParamDto, TripStopsQueryDto } from './dto/trip-stops.dto.js';

/**
 * Trip search: one way, the return leg, a trip's stops, and recent searches.
 *
 * `traveller`, not `bookable`: the story requires a verified traveller, and
 * `bookable` is the profile-complete tier needed to actually book. Search has
 * no guest mode -- which is also what makes the results cacheable, since they
 * are identical for everyone.
 *
 * Nothing here calls identity. The token is verified locally by `JwtAuthGuard`
 * against a public key, so identity being down does not stop a traveller
 * searching.
 *
 * **Route order is load-bearing.** `search/return` and `recent-searches` are
 * declared before `:tripId/stops`; Nest matches in declaration order, so a
 * parameterised route first would swallow `search` as a trip id.
 */
@Controller('trips')
export class CatalogController {
  constructor(private readonly catalog: CatalogService) {}

  @Get('search')
  @RequireAccess('traveller')
  @RateLimit({ bucket: 'trip-search', limit: 60, windowSeconds: 60 })
  async searchOneWay(
    @Query() query: SearchTripsDto,
    // Read here rather than taken from the DTO: the header is what decides the
    // response language, and `language` in the query is only the caller's
    // declared preference travelling on to catalog.
    @Headers('accept-language') acceptLanguage?: string,
  ): Promise<SearchTripsResult> {
    return this.catalog.searchOneWay(query, resolveLanguage(acceptLanguage));
  }

  /**
   * The second list of a round trip.
   *
   * A separate call because the list depends on which outbound trip the
   * traveller chose, which the first call cannot know. Its own rate-limit
   * bucket for the same reason it is its own route: it is a different query
   * with a different cost, and sharing a bucket would let one starve the other.
   */
  @Get('search/return')
  @RequireAccess('traveller')
  @RateLimit({ bucket: 'trip-search-return', limit: 60, windowSeconds: 60 })
  async searchReturn(
    @Query() query: SearchReturnTripsDto,
    @Headers('accept-language') acceptLanguage?: string,
  ): Promise<SearchReturnTripsResult> {
    return this.catalog.searchReturn(query, resolveLanguage(acceptLanguage));
  }

  /**
   * The traveller's recent searches.
   *
   * No account in the path or the query: it comes from the verified token, so
   * there is nothing to supply and nothing to tamper with.
   */
  @Get('recent-searches')
  @RequireAccess('traveller')
  @RateLimit({ bucket: 'recent-searches', limit: 60, windowSeconds: 60 })
  async recentSearches(
    @Query() query: RecentSearchesQueryDto,
  ): Promise<ListRecentSearchesResponse> {
    return this.catalog.recentSearches(query);
  }

  /**
   * What the design's "4 Stops" opens.
   *
   * A higher limit than search: a traveller opens and closes this repeatedly
   * while comparing trips, and it is a cheaper, longer-cached read.
   */
  @Get(':tripId/stops')
  @RequireAccess('traveller')
  @RateLimit({ bucket: 'trip-stops', limit: 120, windowSeconds: 60 })
  async tripStops(
    @Param() params: TripIdParamDto,
    @Query() query: TripStopsQueryDto,
  ): Promise<TripStopsResponse> {
    return this.catalog.tripStops(params.tripId, query);
  }
}
