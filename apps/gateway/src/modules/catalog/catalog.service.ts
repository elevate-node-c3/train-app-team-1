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
  /** Empty results include both a reason code and a readable message. */
  emptyResult?: {
    reason: string;
    message: string;
  };
}

/** Choose localized HTTP messages from catalog's reason codes. */
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
      // Normalize omitted proto3 arrays to the REST contract.
      trips: response.trips ?? [],
      dateStrip: response.dateStrip ?? [],
      filterOptions: filterOptionsOf(response.filterOptions),
      ...(emptyResult
        ? { emptyResult: this.explain(emptyResult, language) }
        : {}),
    };
  }

  /** Return-leg results omit the outbound date picker. */
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

  /** Return stops for the passenger's segment; ensure the array key exists. */
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

  /** Account identity travels in verified gRPC caller metadata, not the request. */
  async recentSearches(
    query: RecentSearchesQueryDto,
  ): Promise<ListRecentSearchesResponse> {
    const response = await this.catalog.listRecentSearches(
      query.language === undefined ? {} : { language: query.language },
    );

    return { recentSearches: response.recentSearches ?? [] };
  }

  /** Render the reason code with its values in the requested language. */
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

/** Keep absent filters undefined so logs and tests can distinguish them. */
export function filtersFrom(
  // Both legs share these filter fields.
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

/** Fill omitted proto3 arrays and numeric bounds with empty or zero defaults. */
function filterOptionsOf(
  filterOptions: SearchOneWayTripsResponse['filterOptions'],
): FilterOptions {
  return {
    trainTypes: filterOptions?.trainTypes ?? [],
    minFareMinor: filterOptions?.minFareMinor ?? 0,
    maxFareMinor: filterOptions?.maxFareMinor ?? 0,
  };
}
