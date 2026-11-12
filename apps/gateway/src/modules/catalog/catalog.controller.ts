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
 * Verified travellers can search before completing their booking profile.
 * Local token checks keep search available during identity outages.
 * Keep literal routes before trip-ID routes.
 */
@Controller('trips')
export class CatalogController {
  constructor(private readonly catalog: CatalogService) {}

  @Get('search')
  @RequireAccess('traveller')
  @RateLimit({ bucket: 'trip-search', limit: 60, windowSeconds: 60 })
  async searchOneWay(
    @Query() query: SearchTripsDto,
    // The header chooses response language; query language is a stored preference.
    @Headers('accept-language') acceptLanguage?: string,
  ): Promise<SearchTripsResult> {
    return this.catalog.searchOneWay(query, resolveLanguage(acceptLanguage));
  }

  /**
   * Search from the selected outbound trip.
   * Separate rate-limit buckets keep either leg from starving the other.
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

  /** Read the account from its verified token, never request parameters. */
  @Get('recent-searches')
  @RequireAccess('traveller')
  @RateLimit({ bucket: 'recent-searches', limit: 60, windowSeconds: 60 })
  async recentSearches(
    @Query() query: RecentSearchesQueryDto,
  ): Promise<ListRecentSearchesResponse> {
    return this.catalog.recentSearches(query);
  }

  /** Cheaper cached stop reads allow a higher limit than trip search. */
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
