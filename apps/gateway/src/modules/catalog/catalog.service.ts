import { Injectable } from '@nestjs/common';
import { resolveMessageWithParams, type SupportedLanguage } from '@app/common';
import type {
  EmptyResult,
  FilterOptions,
  ListRecentSearchesResponse,
  ListStationsRequest,
  ListStationsResponse,
  SearchFilters,
  SearchOneWayTripsResponse,
  SearchReturnTripsResponse,
  StationResponse,
  TripStopsResponse,
} from '@app/contracts';

import { CatalogGrpcClientService } from './catalog.grpc.client.js';
import type { RecentSearchesQueryDto } from './dto/recent-searches.dto.js';
import type { SearchReturnTripsDto } from './dto/search-return-trips.dto.js';
import type { SearchTripsDto } from './dto/search-trips.dto.js';
import type {
  CreateStationDto,
  UpdateStationDto,
} from './dto/station-requests.dto.js';
import type { TripStopsQueryDto } from './dto/trip-stops.dto.js';

/** What the REST endpoint answers with. */
export interface SearchTripsResult extends Omit<
  SearchOneWayTripsResponse,
  'emptyResult' | 'filterOptions'
> {
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

  async listStations(
    request: ListStationsRequest,
  ): Promise<ListStationsResponse> {
    const response = await this.catalog.listStations(request);
    return {
      governorates: (response.governorates ?? []).map((governorate) => ({
        ...governorate,
        stations: governorate.stations ?? [],
      })),
    };
  }

  getStation(stationId: string): Promise<StationResponse> {
    return this.catalog.getStation(stationId);
  }

  createStation(
    request: CreateStationDto,
    idempotencyKey: string,
  ): Promise<StationResponse> {
    return this.catalog.createStation(request, idempotencyKey);
  }

  updateStation(
    stationId: string,
    request: UpdateStationDto,
    idempotencyKey: string,
  ): Promise<StationResponse> {
    return this.catalog.updateStation(
      {
        stationId,
        ...(request.cityId === undefined ? {} : { cityId: request.cityId }),
        ...(request.nameAr === undefined ? {} : { nameAr: request.nameAr }),
        ...(request.nameEn === undefined ? {} : { nameEn: request.nameEn }),
        // The wrapper preserves an explicit [] as a clear, not an omission.
        ...(Object.hasOwn(request, 'altSpellings') &&
        request.altSpellings !== undefined
          ? { aliases: { values: request.altSpellings } }
          : {}),
        ...(request.isActive === undefined
          ? {}
          : { isActive: request.isActive }),
      },
      idempotencyKey,
    );
  }

  deactivateStation(
    stationId: string,
    idempotencyKey: string,
  ): Promise<StationResponse> {
    return this.catalog.deactivateStation(stationId, idempotencyKey);
  }

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
        ? { emptyResult: this.explain(emptyResult, language) }
        : {}),
    };
  }

  /** The return leg: the same shaping, one fewer picker. */
  async searchReturn(
    query: SearchReturnTripsDto,
    language: SupportedLanguage,
  ): Promise<SearchReturnTripsResult> {
    const filters = filtersFrom(query);

    const response = await this.catalog.searchReturnTrips({
      outboundTripId: query.outboundTripId,
      outboundOriginStationId: query.outboundFrom,
      outboundDestinationStationId: query.outboundTo,
      returnDate: query.returnDate,
      travelClassId: query.travelClassId,
      ...(query.sort === undefined ? {} : { sort: query.sort }),
      ...(filters === undefined ? {} : { filters }),
      ...(query.language === undefined ? {} : { language: query.language }),
    });

    const { emptyResult, ...rest } = response;

    return {
      ...rest,
      trips: response.trips ?? [],
      filterOptions: filterOptionsOf(response.filterOptions),
      ...(emptyResult
        ? { emptyResult: this.explain(emptyResult, language) }
        : {}),
    };
  }

  /**
   * A trip's stops, between the two stations the search result offered.
   *
   * Nothing to shape but the absence: proto3 omits an empty repeated field,
   * and a trip with no stops in range is a refusal from catalog rather than an
   * empty list, so `stops: []` here only guards the key's existence.
   */
  async tripStops(
    tripId: string,
    query: TripStopsQueryDto,
  ): Promise<TripStopsResponse> {
    const response = await this.catalog.getTripStops({
      tripId,
      originStationId: query.from,
      destinationStationId: query.to,
      ...(query.language === undefined ? {} : { language: query.language }),
    });

    return { stops: response.stops ?? [] };
  }

  /**
   * The signed-in traveller's recent searches.
   *
   * No account travels in the request: catalog reads the traveller from the
   * caller metadata the gRPC client attaches, which the gateway minted from a
   * verified token.
   */
  async recentSearches(
    query: RecentSearchesQueryDto,
  ): Promise<ListRecentSearchesResponse> {
    const response = await this.catalog.listRecentSearches(
      query.language === undefined ? {} : { language: query.language },
    );

    return { recentSearches: response.recentSearches ?? [] };
  }

  /**
   * An empty result's reason, with the sentence that explains it.
   *
   * The one piece of real work in this service, shared by both legs: catalog
   * returns a reason enum and the values that go in the sentence, and the words
   * are chosen here because `Accept-Language` is resolved at the edge and
   * nowhere else (BR-56). The catalogue is keyed by the wire enum, so there is
   * no mapping table in between.
   */
  private explain(
    emptyResult: EmptyResult,
    language: SupportedLanguage,
  ): { reason: string; message: string } {
    return {
      reason: emptyResult.reason,
      message: resolveMessageWithParams(
        emptyResult.reason,
        language,
        emptyResult.params ?? {},
      ),
    };
  }
}

/**
 * The second list of a round trip.
 *
 * Shaped like the one-way result minus the picker: no date strip and no
 * booking window, because the outbound call already sent both and two copies
 * could disagree.
 */
export interface SearchReturnTripsResult extends Omit<
  SearchReturnTripsResponse,
  'emptyResult' | 'filterOptions'
> {
  filterOptions: FilterOptions;
  emptyResult?: {
    reason: string;
    message: string;
  };
}

/**
 * The filter fields as one wire object, or nothing at all.
 *
 * Absent rather than `{}` when the traveller filtered nothing: proto3 would
 * send an empty message either way, but an explicit `undefined` keeps "no
 * filters" distinguishable in a log and in a test.
 */
export function filtersFrom(
  // Structural rather than a union of the two DTOs: both legs filter by the
  // same five things, and that is the only part of them this reads.
  query: Pick<
    SearchTripsDto,
    | 'trainTypeIds'
    | 'departAfter'
    | 'departBefore'
    | 'maxFare'
    | 'excludeSoldOut'
  >,
): SearchFilters | undefined {
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
