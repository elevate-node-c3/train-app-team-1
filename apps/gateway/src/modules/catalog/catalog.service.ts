import { Injectable } from '@nestjs/common';
import { resolveMessageWithParams, type SupportedLanguage } from '@app/common';
import type {
  FilterOptions,
  SearchFilters,
  SearchOneWayTripsResponse,
} from '@app/contracts';

import { CatalogGrpcClientService } from './catalog.grpc.client.js';
import type { SearchTripsDto } from './dto/search-trips.dto.js';

/** What the REST endpoint answers with. */
export interface SearchTripsResult
  extends Omit<SearchOneWayTripsResponse, 'emptyResult' | 'filterOptions'> {
  /** Always present, even when the day offered nothing to narrow. */
  filterOptions: FilterOptions;
  /**
   * Present only when `trips` is empty. The reason is kept beside the sentence
   * so a client can branch on the code and still have something to show.
   */
  emptyResult?: {
    reason: string;
    message: string;
  };
}

/**
 * Shapes a search for the HTTP edge.
 *
 * The one piece of real work here is the language. Catalog returns a reason
 * enum and the values that go in the sentence; the words are chosen here,
 * because `Accept-Language` is resolved at the edge and nowhere else (BR-56).
 * That is what keeps catalog free of any language at all, and why the message
 * catalogue is keyed by the wire enum -- no mapping table in between.
 */
@Injectable()
export class CatalogService {
  constructor(private readonly catalog: CatalogGrpcClientService) {}

  async searchOneWay(
    query: SearchTripsDto,
    language: SupportedLanguage,
  ): Promise<SearchTripsResult> {
    const filters = filtersFrom(query);

    const response = await this.catalog.searchOneWayTrips({
      originStationId: query.from,
      destinationStationId: query.to,
      departureDate: query.departureDate,
      travelClassId: query.travelClassId,
      ...(query.trainNumber === undefined
        ? {}
        : { trainNumber: query.trainNumber }),
      ...(query.returnDate === undefined
        ? {}
        : { returnDate: query.returnDate }),
      ...(query.sort === undefined ? {} : { sort: query.sort }),
      ...(filters === undefined ? {} : { filters }),
      ...(query.language === undefined ? {} : { language: query.language }),
    });

    const { emptyResult, ...rest } = response;

    return {
      ...rest,
      // proto3 omits an empty repeated field, so a day with no trips arrives
      // with no `trips` key at all. The REST contract must not make a client
      // guess that absent means empty -- it is the difference between "no
      // trains" and "the server forgot to tell me".
      trips: response.trips ?? [],
      dateStrip: response.dateStrip ?? [],
      filterOptions: filterOptionsOf(response.filterOptions),
      ...(emptyResult
        ? {
            emptyResult: {
              reason: emptyResult.reason,
              message: resolveMessageWithParams(
                emptyResult.reason,
                language,
                emptyResult.params ?? {},
              ),
            },
          }
        : {}),
    };
  }
}

/**
 * The filter fields as one wire object, or nothing at all.
 *
 * Absent rather than `{}` when the traveller filtered nothing: proto3 would
 * send an empty message either way, but an explicit `undefined` keeps "no
 * filters" distinguishable in a log and in a test.
 */
export function filtersFrom(query: SearchTripsDto): SearchFilters | undefined {
  const filters: SearchFilters = {
    ...(query.trainTypeIds === undefined
      ? {}
      : { trainTypeIds: query.trainTypeIds }),
    ...(query.departAfter === undefined
      ? {}
      : { departAfterMinutes: query.departAfter }),
    ...(query.departBefore === undefined
      ? {}
      : { departBeforeMinutes: query.departBefore }),
    ...(query.maxFare === undefined ? {} : { maxFareMinor: query.maxFare }),
    ...(query.excludeSoldOut === undefined
      ? {}
      : { excludeSoldOut: query.excludeSoldOut }),
  };

  return Object.keys(filters).length === 0 ? undefined : filters;
}

/**
 * The day's facets, with proto3's absences filled in.
 *
 * `trainTypes` is a repeated field, so an empty one arrives as no key at all,
 * and a client reading `filterOptions.trainTypes.length` would throw. The fare
 * range defaults to zero for the same reason: an int32 that is 0 is omitted on
 * the wire, which is indistinguishable from "a free trip" unless the edge
 * restores it.
 */
function filterOptionsOf(
  filterOptions: SearchOneWayTripsResponse['filterOptions'],
): FilterOptions {
  return {
    trainTypes: filterOptions?.trainTypes ?? [],
    minFareMinor: filterOptions?.minFareMinor ?? 0,
    maxFareMinor: filterOptions?.maxFareMinor ?? 0,
  };
}
