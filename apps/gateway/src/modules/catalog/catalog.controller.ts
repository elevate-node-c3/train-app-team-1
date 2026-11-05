import { Controller, Get, Headers, Query } from '@nestjs/common';
import { RateLimit, RequireAccess, resolveLanguage } from '@app/common';

import { CatalogService, type SearchTripsResult } from './catalog.service.js';
import { SearchTripsDto } from './dto/search-trips.dto.js';

/**
 * One-way search.
 *
 * `traveller`, not `bookable`: the story requires a verified traveller, and
 * `bookable` is the profile-complete tier needed to actually book. Search has
 * no guest mode -- which is also what makes the results cacheable, since they
 * are identical for everyone.
 *
 * Nothing here calls identity. The token is verified locally by `JwtAuthGuard`
 * against a public key, so identity being down does not stop a traveller
 * searching.
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
}
